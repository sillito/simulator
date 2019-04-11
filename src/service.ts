//
// A mock HTTP service that can be one of three types:
//
// * A timed service that takes a request, waits an amount of time (determined
//   sampling from a normal distribution) and then returns a 200 or 500 response
//   (determined by a weighted coin toss).
//
// * A serial service, which calls a list of depenedent services one after the
//   other and then returns a 200 response, assuming all dependent calls succeed.
//   If any of the calls fail, the service return 500 (without waiting to call
//   additional dependencies).
//
// * A concurrent service, which is similar to a serial service, except that the
//   dependencies are called concurrently.
//

const http = require("http");
const url = require("url");
const seedrandom = require("seedrandom");

// command line arguments take in a single config file for this service
const args = require("minimist")(process.argv.slice(2), {
  default: {
    config: "./service.example.json"
  }
});

type Configuration = {
  name: string;
  hostname: string;
  type: string;
  port: number;
  log_level: number;
  mean: number;
  std: number;
  failure_rate: number;
  failure_mean: number;
  failure_std: number;
  response_size: number;
  failure_response_size: number;
  cache_hit_rate: number;
  dependencies: {
    service: string;
  }[];
  max_tries: number;
  timeout: number;
  seed: string;
  fallback: boolean;
};

const defaultConfig: Configuration = {
  name: "bork",
  hostname: "127.0.0.1",
  type: "timed",
  port: 3000,
  log_level: 3,
  mean: 200,
  std: 50,
  response_size: 1024,
  failure_rate: 0,
  failure_mean: 100,
  failure_std: 25,
  failure_response_size: 512,
  cache_hit_rate: 0,
  dependencies: [],
  max_tries: 1,
  timeout: 200,
  seed: "secret",
  fallback: false
};
let specifiedConfig: Configuration;
try {
  specifiedConfig = require(args.config);
} catch (err) {
  throw new Error(`Invalid Configuration File Path Specified: ${args.config}`);
}
const config: Configuration = {
  ...defaultConfig,
  ...specifiedConfig
};
const rng = seedrandom(config.seed);

// a running counter of the number of currently active requests
let connectionsCount = 0;

//
// Each request is assigned a request id (unless a request id is passed as part
// of the request's query string). ATM, this is just a simple one-up counter.
//
let newRequestId = 0;

// return the existing Id or generate an auto incrementing ID
function getRequestId(request) {
  const query = url.parse(request.url, true).query;
  return query.requestId || ++newRequestId;
}

//
// Listen for requests, and respond with a status code, and response time
// determined by a set of rules intended to simulate a real service
//
// TODO: add support for reading the body of a POST request, before taking
// action on the request
//
const server = http.createServer(async (req, res) => {
  connectionsCount++;

  const startTime = Date.now();
  const startConnections = connectionsCount;
  let waitTime = 0;

  const requestId = getRequestId(req);

  req.on("aborted", () => {
    const elapsedTime = Date.now() - startTime;
    log(DEBUG, `Request aborted ${elapsedTime}ms (${waitTime}ms)`, requestId);
  });

  res.on("finish", () => {
    const elapsedTime = Date.now() - startTime;
    log(
      DEBUG,
      `cons at start=${startConnections}, at end=${connectionsCount}`,
      requestId
    );
    log(DEBUG, `sampled ms=${waitTime}, actual ms=${elapsedTime}`, requestId);

    recordMetrics({
      requestId,
      status: res.statusCode,
      elapsedTime
    });

    connectionsCount -= 1;
  });

  //
  // Handle this request based on the type flag we were configured
  // with at start up
  //

  if (config.type === "timed") {
    if (weightedCoinToss(config.failure_rate)) {
      waitTime = parseInt(
        normalSample(config.failure_mean, config.failure_std)
      );
      setTimeout(respond, waitTime, res, 500);
    } else {
      waitTime = parseInt(normalSample(config.mean, config.std));
      setTimeout(respond, waitTime, res, 200);
    }
  } else {
    // TODO probably should use url module to construct this
    const serviceURLs = config.dependencies.map(
      dependency => `${dependency.service}/?request_id=${requestId}`
    );

    let status;
    if (config.type === "serial") {
      status = await callServicesSerially(requestId, serviceURLs);
    } else if (config.type === "concurrent") {
      status = await callServicesConcurrently(requestId, serviceURLs);
    } else {
      log(FATAL, `Unknown service type ${config.type}`);
    }

    if (status) {
      respond(res, status);
    }
  }
});

export async function callService(requestId, serviceURL) {
  //
  // Call serviceURL and call cb with the status code when the service call
  // is complete.
  //
  var startTime = Date.now();
  if (weightedCoinToss(config.cache_hit_rate)) {
    recordMetrics({
      requestId,
      service: serviceURL,
      cache: true,
      tries: 0,
      dependencyTime: Date.now() - startTime
    });
    return 200;
  }
  const { response, attempt } = await attemptRequestToService(serviceURL);

  const fallback = config.fallback && response.statusCode == 500;

  recordMetrics({
    requestId,
    service: serviceURL,
    status: response.statusCode,
    tries: attempt,
    dependencyTime: Date.now() - startTime,
    fallback
  });

  // Inject fallback strategies here. Right now strategy is to just set statusCode to 200
  return fallback ? 200 : response.statusCode;
}

async function attemptRequestToService(
  serviceURL,
  attempt = 0,
  error = null
): Promise<{ response: { statusCode: Number }; attempt: Number }> {
  attempt++;
  if (attempt > config.max_tries) {
    return { response: { statusCode: 500 }, attempt: config.max_tries }; // TODO: what should we do when we hit max_tries?
  }

  if (error) {
    log(
      DEBUG,
      `Retry due to ${error.message} (${attempt} of ${config.max_tries})`
    );
  }

  return new Promise((resolve, reject) => {
    let request = http.request(serviceURL, response => {
      response.on("data", () => {});
      response.on("end", () => {
        if (response.statusCode === 500) {
          // retry on error response
          resolve(
            attemptRequestToService(serviceURL, attempt, {
              message: "500 status code"
            })
          );
        } else {
          resolve({ response, attempt });
        }
      });
    });

    request.on("error", e => {
      console.error("Error caught", e);
      // retry on any connection errors
      resolve(attemptRequestToService(serviceURL, attempt, e));
    });

    // setting a timeout also implictly destroys socket
    request.setTimeout(config.timeout);

    request.end();
  });
}

//
// The following two functions call each service in a list of service urls. The
// first calls all services concurrently, the second calls them serially. In
// either case, if one of the services responds with a status code of 500, we
// respond with a status code of 500, without waiting for all service calls.
//

async function callServicesConcurrently(requestId, serviceURLs) {
  let responsesPending = serviceURLs.length; // TODO might be worth logging this value on 500

  return new Promise(resolve => {
    serviceURLs.forEach(async serviceURL => {
      const status = await callService(requestId, serviceURL);

      // immediately return 500 error, don't allow future services calls to respond
      if (status === 500) {
        return resolve(status);
      }

      // after we have processed all, respond 200
      responsesPending--;
      if (responsesPending === 0) {
        // all service calls are complete
        return resolve(status);
      }
    });
  });
}

export async function callServicesSerially(requestId, serviceURLs) {
  var serviceURL = serviceURLs.shift();

  // recurse until out of URLs to process
  if (!serviceURL) {
    return 200;
  }

  const status = await callService(requestId, serviceURL);
  if (status === 500) {
    return status;
  }

  return callServicesSerially(requestId, serviceURLs);
}

//
// This service always responds in one of two ways: 200 or 500
//

export function respond(res, status) {
  let body;
  if (status == 200) {
    // body = Buffer.alloc(config.response_size);
    body = "hi";
  } else if (status == 500) {
    body = "error"; //Buffer.alloc(config.failure_response_size);
  } else {
    body = "error"; //Buffer.alloc(config.failure_response_size);
    log(
      ERROR,
      `Unexpected response status ${status} requested to be set. Sending failure instead.`
    );
  }

  res.statusCode = status;
  res.setHeader("Content-Type", "text/html");
  res.setHeader("Content-Length", body.length);
  res.end(body);
}

//
// logging facility (just logs to console, atm)
//

const DEBUG = 4,
  INFO = 3,
  WARN = 2,
  ERROR = 1,
  FATAL = 0;
const LOG_LEVEL_NAMES = ["FATAL", "ERROR", "WARN", "INFO", "DEBUG"];

function log(level, message, requestId = "") {
  if (level > config.log_level) return;

  console.error(
    `[${config.name}]\t${LOG_LEVEL_NAMES[level]}\t${requestId}\t ${message}`
  );
}

function recordMetrics(metrics) {
  console.log(JSON.stringify(metrics));
}

/**
 * Sample from a common distribution
 * @param mean
 * @param std
 */
function normalSample(mean, std) {
  return standardNormalSample() * std + mean;
}

/**
 * Math.random() is a uniform distribution, we use the Box-Muller
 * transform to get a normal distribution:
 * https://en.wikipedia.org/wiki/Box–Muller_transform
 * https://stackoverflow.com/questions/25582882
 */
function standardNormalSample() {
  let u = 0,
    v = 0;
  while (u === 0) u = rng(); // converting [0,1) to (0,1)
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/**
 * Generate a chance to enter into this branch.
 *
 * @return boolean true with probabilty 'weight' (in the interval [0..1]) and
 * false with probabilty '1-weight'
 */
function weightedCoinToss(weight) {
  return rng() < weight;
}

// main entry point, when service is called directly from command line
if (require.main === module) {
  server.listen(config.port, config.hostname, () => {
    log(INFO, `Service running at http://${config.hostname}:${config.port}/`);
    log(DEBUG, `With config ${JSON.stringify(config)}`);
  });
}
