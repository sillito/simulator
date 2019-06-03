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

import {
  DependencyPool,
  DependencyResponse,
  Dependency
} from "./DependencyPool";
import * as defaultsDeep from "lodash.defaultsdeep";

import * as http from "http";
import * as url from "url";
import * as seedrandom from "seedrandom";

// Properties that can be passed along to other services via querystring
export type Req = {
  requestId: string;
  value?: number;
  response?: Res;
};

export type Res = {
  statusCode?: number;
  value?: number[];
};

export type ServiceConfiguration = {
  name: string;
  hostname: string;
  type: "timed" | "serial" | "concurrent";
  port: number;
  log_level: number;
  timedResponseSettings: {
    mean: number;
    std: number;
    value: number;
    failureRate: number;
    failureMean: number;
    failureStd: number;
    failureValue: number;
  };
  response_size: number;
  failure_response_size: number;
  cache_hit_rate: number;
  cacheHitValue: number;
  dependencies: Dependency[];
  max_tries: number;
  timeout: number;
  seed: string;
  fallback: boolean;
};

// The Server configuration, passed in through command line and defaulted.
let config: ServiceConfiguration;

// A seeded random number generator
let rng;

// Dependency level Information
const dependencies: { [service: string]: DependencyPool } = {};

// a running counter of the number of currently active requests
let connectionsCount = 0;

// The ID assigned to new requests.
let newRequestId = 0;

function loadConfiguration() {
  // command line arguments take in a single config file for this service
  const args = require("minimist")(process.argv.slice(2), {
    default: {
      config: null,
      configJSON: null
    }
  });
  const defaultConfig: ServiceConfiguration = {
    name: "bork",
    hostname: "127.0.0.1",
    type: "timed",
    port: 3000,
    log_level: 3,
    timedResponseSettings: {
      mean: 200,
      std: 50,
      value: 0,
      failureRate: 0,
      failureMean: 100,
      failureStd: 25,
      failureValue: 0
    },
    response_size: 1024,
    failure_response_size: 512,
    cache_hit_rate: 0,
    cacheHitValue: 0.5,
    dependencies: [],
    max_tries: 1,
    timeout: 200,
    seed: "secret",
    fallback: false
  };
  let specifiedConfig: ServiceConfiguration;
  if (!args.config && !args.configJSON) {
    throw new Error(
      `No Configuration was specified for the ${args.name} service.`
    );
  }
  if (args.config) {
    try {
      specifiedConfig = { ...require(args.config) };
    } catch (err) {
      throw new Error(
        `Invalid Configuration File Path (${args.config}) specified for ${
          args.name
        }`
      );
    }
  } else if (args.configJSON) {
    // unescape. Escaping used just for shell which doesn't like double quotes.
    specifiedConfig = JSON.parse(args.configJSON.replace(/\\"/g, '"'));
  }
  config = defaultsDeep(specifiedConfig, defaultConfig);
  //config = merge(defaultConfig, specifiedConfig);
  console.error(JSON.stringify(config, null, "  "));

  config.dependencies.forEach(dep => {
    dependencies[dep.service] = new DependencyPool(
      dep,
      attemptRequestToService
    );
  });

  rng = seedrandom(config.seed);
}

// return the existing Id or generate an auto incrementing ID
function getRequestId(request): number {
  const query = url.parse(request.url, true).query;
  return Number(query.requestId) || ++newRequestId;
}

const server = http.createServer(async (req, res) => {
  connectionsCount++;

  const startTime = Date.now();
  const startConnections = connectionsCount;
  let waitTime = 0;

  const requestId: string = "" + getRequestId(req);
  const request: Req = {
    requestId,
    value: 99,
    response: {
      value: []
    }
  };

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
      request,
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
    const timedConfig = config.timedResponseSettings;
    const response = request.response;
    if (weightedCoinToss(timedConfig.failureRate)) {
      response.statusCode = 500;
      response.value.push(timedConfig.failureValue);

      waitTime = normalSample(timedConfig.failureMean, timedConfig.failureStd);
      setTimeout(respond, waitTime, res, request);
    } else {
      response.statusCode = 200;
      response.value.push(timedConfig.value);

      waitTime = normalSample(timedConfig.mean, timedConfig.std);
      setTimeout(respond, waitTime, res, request);
    }
  } else {
    let response;
    if (config.type === "serial") {
      response = await callServicesSerially(request, config.dependencies);
    } else if (config.type === "concurrent") {
      response = await callServicesConcurrently(request, config.dependencies);
    } else {
      return log(FATAL, `Unknown service type ${config.type}`);
    }
    request.response = response;

    respond(res, request);
  }
});

export async function callService(
  request: Req,
  dependency: Dependency
): Promise<Res> {
  // Account for cache hit
  var startTime = Date.now();
  if (weightedCoinToss(config.cache_hit_rate)) {
    recordMetrics({
      request,
      dependency: dependency.name,
      cache: true,
      tries: 0,
      dependencyTime: Date.now() - startTime
    });
    return { value: [config.cacheHitValue], statusCode: 200 };
  }

  // here is place for circuit breaker

  // Queue
  let dependencyResponse: DependencyResponse;
  const dep: DependencyPool = dependencies[dependency.service];
  try {
    dependencyResponse = await dep.add(request);
  } catch (err) {
    // console.error("TTTTTTTTTTTTTTTT", err);
    // A rejection can occur while waiting for the dependency
    recordMetrics({
      request,
      dependency: dependency.name,
      status: 500,
      tries: 0,
      dependencyTime: Date.now() - startTime,
      fallback: true
    });

    return await dep.fallback(request);
  }

  // read the actual service response
  const { response, attempt } = dependencyResponse;

  request.response.value.push(request.value);

  if (response.statusCode >= 500) {
    console.error("XXXXXXXXXXXXXXXXX", response, request);
  }

  // Account for fallback, if execution fails.
  const shouldFallback = config.fallback && response.statusCode == 500;

  if (shouldFallback) {
    let fallbackResponse = await dep.fallback(request);
    // overwrite response, since we use the fallback for status and value provided
    request.response = fallbackResponse;
  }

  // record metrics
  recordMetrics({
    request,
    dependency: dependency.name,
    status: response.statusCode,
    tries: attempt,
    dependencyTime: Date.now() - startTime,
    fallback: shouldFallback
  });

  return response;
}

async function attemptRequestToService(
  serviceURL,
  attempt = 0,
  error = null
): Promise<DependencyResponse> {
  if (serviceURL.includes(":80")) {
    console.error("BAD SERVICE", serviceURL);
  }

  attempt++;
  if (attempt > config.max_tries) {
    console.error("WWWWWWWWWW", error);
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
      let body = "";
      response.on("data", chunk => {
        body += chunk;
      });
      response.on("end", () => {
        if (response.statusCode === 500) {
          // retry on error response
          resolve(
            attemptRequestToService(serviceURL, attempt, {
              message: "500 status code - " + body
            })
          );
        } else {
          const parsed = JSON.parse(body);
          resolve({ response: parsed, attempt });
        }
      });
    });

    request.on("error", e => {
      console.error("Error caught", e);
      // retry on any connection errors
      resolve(attemptRequestToService(serviceURL, attempt, e));
    });

    // setting a timeout also implictly destroys socket
    request.setTimeout(config.timeout, function() {
      console.error("XXXXXXXXXXXXXX timeout reached");
      request.abort();
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

async function callServicesConcurrently(
  request: Req,
  dependencies: Dependency[]
): Promise<Res> {
  let result = { value: [], statusCode: 200 };
  let responsesPending = dependencies.length; // TODO might be worth logging this value on 500

  return new Promise(resolve => {
    dependencies.forEach(async dep => {
      const response = await callService(request, dep);

      // hard dependencies fail the collection of services, returning 0.
      // TODO: try keeping value to see value of dropped responses after
      //       they have failed some point down the line.
      if (response.statusCode === 500 && dep.type == "hard") {
        console.error("EEEEEEEEEEEE", response);
        return resolve({ value: [-10], statusCode: 500 });
      }
      result.value.push(response.value);

      // after we have processed all, respond 200
      responsesPending--;
      if (responsesPending === 0) {
        // all service calls are complete
        return resolve(result);
      }
    });
  });
}

export async function callServicesSerially(
  request: Req,
  dependencies: Dependency[]
): Promise<Res> {
  let result = { value: [], statusCode: 200 };
  if (dependencies.length == 0) return result;

  for (const dep of dependencies) {
    const response = await callService(request, dep);

    // hard dependencies fail the collection of services, returning 0.
    // TODO: try keeping value to see value of dropped responses after
    //       they have failed some point down the line.
    if (response.statusCode === 500 && dep.type == "hard") {
      return { value: [-6], statusCode: 500 };
    }
    result.value.push(response.value);
  }

  return result;
}

//
// This service always responds in one of two ways: 200 or 500
//

export function respond(res, request: Req) {
  const responseText = JSON.stringify(request.response);
  res.statusCode = request.response.statusCode;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Length", responseText.length);
  res.end(responseText);
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
  loadConfiguration();
  server.listen(config.port, config.hostname, () => {
    log(INFO, `Service running at http://${config.hostname}:${config.port}/`);
    log(DEBUG, `With config ${JSON.stringify(config)}`);
    process.on("SIGTERM", () => process.exit());
    process.on("SIGINT", () => process.exit());
  });
}
