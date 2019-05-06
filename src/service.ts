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

import { DeferredPromise } from "./DeferredPromise";
import {
  DependencyPool,
  DependencyResponse,
  Dependency
} from "./DependencyPool";
import * as querystring from "querystring";

const http = require("http");
const url = require("url");
const seedrandom = require("seedrandom");

// Properties that can be passed along to other services via querystring
export type Req = {
  requestId: number;
  value?: number;
};

type Configuration = {
  name: string;
  hostname: string;
  type: "timed" | "serial" | "concurrent";
  port: number;
  log_level: number;
  timedResponseSettings: {
    mean: number;
    std: number;
    failureRate: number;
    failureMean: number;
    failureStd: number;
  };
  response_size: number;
  failure_response_size: number;
  cache_hit_rate: number;
  dependencies: Dependency[];
  max_tries: number;
  timeout: number;
  seed: string;
  fallback: boolean;
};

// The Server configuration, passed in through command line and defaulted.
let config: Configuration;

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
      config: "./service.example.json"
    }
  });
  const defaultConfig: Configuration = {
    name: "bork",
    hostname: "127.0.0.1",
    type: "timed",
    port: 3000,
    log_level: 3,
    timedResponseSettings: {
      mean: 200,
      std: 50,
      failureRate: 0,
      failureMean: 100,
      failureStd: 25
    },
    response_size: 1024,
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
    throw new Error(
      `Invalid Configuration File Path Specified: ${args.config}`
    );
  }
  config = {
    ...defaultConfig,
    ...specifiedConfig
  };

  config.dependencies.forEach(dep => {
    dependencies[dep.service] = new DependencyPool(
      dep,
      attemptRequestToService
    );
  });

  rng = seedrandom(config.seed);
}

// return the existing Id or generate an auto incrementing ID
function getRequestId(request) {
  const query = url.parse(request.url, true).query;
  return query.requestId || ++newRequestId;
}

const server = http.createServer(async (req, res) => {
  connectionsCount++;

  const startTime = Date.now();
  const startConnections = connectionsCount;
  let waitTime = 0;

  const requestId = getRequestId(req);
  const request: Req = {
    requestId,
    value: Math.random()
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
    const timedConfig = config.timedResponseSettings;
    if (weightedCoinToss(timedConfig.failureRate)) {
      waitTime = parseInt(
        normalSample(timedConfig.failureMean, timedConfig.failureStd)
      );
      setTimeout(respond, waitTime, res, 500);
    } else {
      waitTime = parseInt(normalSample(timedConfig.mean, timedConfig.std));
      setTimeout(respond, waitTime, res, 200);
    }
  } else {
    const services = config.dependencies.map(dep => dep.service);

    let status;
    if (config.type === "serial") {
      status = await callServicesSerially(request, services);
    } else if (config.type === "concurrent") {
      status = await callServicesConcurrently(request, services);
    } else {
      log(FATAL, `Unknown service type ${config.type}`);
    }

    if (status) {
      respond(res, status);
    }
  }
});

export async function callService(request: Req, service: string) {
  // Account for cache hit
  var startTime = Date.now();
  if (weightedCoinToss(config.cache_hit_rate)) {
    recordMetrics({
      requestId: request.requestId,
      service: service,
      cache: true,
      tries: 0,
      dependencyTime: Date.now() - startTime
    });
    return 200;
  }

  // here is place for circuit breaker

  // Queue
  let dependencyResponse: DependencyResponse;
  const dependency: DependencyPool = dependencies[service];
  try {
    dependencyResponse = await dependency.add(request);
  } catch (err) {
    // A rejection can occur while waiting for the dependency
    recordMetrics({
      requestId: request.requestId,
      service,
      status: 500,
      tries: 0,
      dependencyTime: Date.now() - startTime,
      fallback: true
    });

    let x = await dependency.fallback(request);
    return x;
  }

  // call the actual service
  const { response, attempt } = dependencyResponse;
  let status = response.statusCode;

  // Account for fallback, if execution fails.
  const shouldFallback = config.fallback && status == 500;

  if (shouldFallback) {
    status = await dependency.fallback(request);
  }

  // record metrics
  recordMetrics({
    requestId: request.requestId,
    service,
    status,
    tries: attempt,
    dependencyTime: Date.now() - startTime,
    fallback: shouldFallback
  });

  return response.statusCode;
}

async function attemptRequestToService(
  serviceURL,
  attempt = 0,
  error = null
): Promise<DependencyResponse> {
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

async function callServicesConcurrently(request: Req, serviceURLs) {
  let responsesPending = serviceURLs.length; // TODO might be worth logging this value on 500

  return new Promise(resolve => {
    serviceURLs.forEach(async serviceURL => {
      const status = await callService(request, serviceURL);

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

export async function callServicesSerially(request: Req, serviceURLs) {
  var serviceURL = serviceURLs.shift();

  // recurse until out of URLs to process
  if (!serviceURL) {
    return 200;
  }

  const status = await callService(request, serviceURL);
  if (status === 500) {
    return status;
  }

  return callServicesSerially(request, serviceURLs);
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
  loadConfiguration();
  server.listen(config.port, config.hostname, () => {
    log(INFO, `Service running at http://${config.hostname}:${config.port}/`);
    log(DEBUG, `With config ${JSON.stringify(config)}`);
  });
}
