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
// TODO
// * Add additional distribution types, and make the distribution used
//   configurable
//
const http = require("http");
const url = require("url");
const seedrandom = require("seedrandom");

//
// configure service using command line arguments, and these defaults
//
const args = require("minimist")(process.argv.slice(2), {
  default: {
    name: "s1",
    port: 3000,
    hostname: "127.0.0.1",
    log_level: 3,
    mean: 200,
    std: 50,
    failure_rate: 0.01,
    failure_mean: 100,
    failure_std: 25,
    response_size: 1024 * 1024,
    failure_response_size: 512,
    services: [],
    type: "timed",
    max_tries: 5, // global value for all dependencies, atm
    timeout: 200, // global value for all dependencies, atm
    seed: "secret"
  }
});

const rng = seedrandom(args.seed);

function usage() {
  //
  // print a (hopefully) informative usage message
  //
  console.error("USAGE: node simulator.js ARGS");
  console.error("\t--usage\t\tprint this message");
  console.error("\t--name <name>\ta name for this service name");
  console.error("\t--port <port to listen on>");
  console.error("\t--hostname <service hostname>");
  console.error("\t--log_level [0...4]");
  console.error("\nPerformance distribution (200s)");
  console.error("\t--mean <mean>");
  console.error("\t--std <standard deviation>");
  console.error("\t--response_size <bytes>");
  console.error("\nPerformance distribution (500s)");
  console.error("\t--failure_rate [0..1]");
  console.error("\t--failure_mean <mean>");
  console.error("\t--failure_std <standard deviation>");
  console.error("\t--failure_response_size <bytes>");
  console.error("\nServices dependencies");
  console.error("\t--services <list of urls>");
  console.error("\t--type timed|serial|concurrent");
  console.error("\t--max_tries <number>");
  console.error("\t--timeout <number in ms>");
}

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
      serverSideTime: elapsedTime
    });

    connectionsCount -= 1;
  });

  //
  // Handle this request based on the type flag we were configured
  // with at start up
  //

  if (args.type === "timed") {
    if (weightedCoinToss(args.failure_rate)) {
      waitTime = parseInt(normalSample(args.failure_mean, args.failure_std));
      setTimeout(respond, waitTime, res, 500);
    } else {
      waitTime = parseInt(normalSample(args.mean, args.std));
      setTimeout(respond, waitTime, res, 200);
    }
  } else {
    // TODO probably should use url module to construct this
    const serviceURLs = args.services
      .split(",")
      .map(host => `${host}/?request_id=${requestId}`);

    let status;
    if (args.type === "serial") {
      status = await callServicesSerially(requestId, serviceURLs);
    } else if (args.type === "concurrent") {
      status = await callServicesConcurrently(requestId, serviceURLs);
    } else {
      log(FATAL, `Unknown service type ${args.type}`);
    }

    if (status) {
      respond(res, status);
    }
  }
});

async function callService(requestId, serviceURL) {
  //
  // Call serviceURL and call cb with the status code when the service call
  // is complete.
  //
  var startTime = Date.now();
  const { response, attempt } = await attemptRequestToService(serviceURL);
  recordMetrics({
    requestId,
    service: serviceURL,
    status: response.statusCode,
    tries: attempt,
    clientSideTime: Date.now() - startTime
  });

  return response.statusCode;
}

async function attemptRequestToService(serviceURL, attempt = 0, error = null) {
  attempt++;
  if (attempt > args.max_tries) {
    return { response: { statusCode: 500 }, attempt }; // TODO: what should we do when we hit max_tries?
  }

  if (error) {
    log(
      DEBUG,
      `Retry due to ${error.message} (${attempt} of ${args.max_tries})`
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
      // retry on any connection errors
      resolve(attemptRequestToService(serviceURL, attempt, e));
    });

    // TODO: Verify setting a timeout without defining a function. If it auto-triggers socket, channel destruction
    request.setTimeout(args.timeout, () => {
      request.socket.destroy(); // this will trigger an error event
      reject("Request Timeout");
    });

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

async function callServicesSerially(requestId, serviceURLs) {
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

function respond(res, status) {
  let body;
  if (status == 200) {
    body = Buffer.alloc(args.response_size);
  } else if (status == 500) {
    body = Buffer.alloc(args.failure_response_size);
  } else {
    body = Buffer.alloc(args.failure_response_size);
    log(
      ERROR,
      `Unexpected response status ${status} requested to be set. Sending failure instead.`
    );
  }

  res.statusCode = status;
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", body.byteLength);
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
  if (level > args.log_level) return;

  console.error(
    `[${args.name}]\t${LOG_LEVEL_NAMES[level]}\t${requestId}\t ${message}`
  );
}

function recordMetrics(requestId, metrics) {
  console.log(JSON.stringify(metrics));
}

//
// functions for sampling from common distributions
//

function normalSample(mean, std) {
  return standardNormalSample() * std + mean;
}

function standardNormalSample() {
  //
  // Math.random() is a uniform distribution, we use the Box-Muller
  // transform to get a normal distribution:
  // https://en.wikipedia.org/wiki/Box–Muller_transform
  // https://stackoverflow.com/questions/25582882
  //
  var u = 0,
    v = 0;
  while (u === 0) u = rng(); // converting [0,1) to (0,1)
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function poisson_sample() {
  // TODO
}

function weightedCoinToss(weight) {
  //
  // returns true with probabilty 'weight' (in the interval [0..1]) and
  // false with probabilty '1-weight'
  //
  return rng() < weight;
}

//
// main entry point, when service is called directly from command line
//

if (require.main === module) {
  if (args.usage) {
    usage();
    process.exit(1);
  }

  server.listen(args.port, args.hostname, () => {
    log(INFO, `Service running at http://${args.hostname}:${args.port}/`);
    log(DEBUG, `With args ${JSON.stringify(args)}`);
  });
}
