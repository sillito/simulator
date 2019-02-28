//
// Read JSON format metrics from stdin and produce a summary of the experiment, which
// includes latency (min, max and mean), availability (ie, % of 200 responses) number
// of and requests and number of tries to get a response from a dependent service.
//
// TODO: Really we care about the latency distribution, not just the min, max and mean
//
const process = require("process");
const readline = require("readline").createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});
const cTable = require("console.table");

//
// Metrics to report
//

let requests = 0;
const status = {
  200: 0,
  500: 0
};
const latency = {
  total: 0,
  min: Number.MAX_VALUE,
  max: 0
};

const dependency = {
  attempts: 0,
  fallbacks: 0,
  cacheHits: 0
};

var args = require("minimist")(process.argv.slice(2), {
  default: {
    trial: 0,
    csv: false,
    header: false
  }
});

readline.on("line", line => {
  let metrics = JSON.parse(line);

  if (metrics.elapsedTime != undefined) {
    // metrics about this service
    requests += 1;
    latency.total += metrics.elapsedTime;
    latency.min = Math.min(metrics.elapsedTime, latency.min);
    latency.max = Math.max(metrics.elapsedTime, latency.max);

    status[metrics.status] = status[metrics.status] + 1;
  } else {
    // metrics about a dependency this service used
    dependency.attempts += metrics.tries;
    dependency.cacheHits += metrics.cache ? 1 : 0;
    dependency.fallbacks += metrics.fallback ? 1 : 0;
  }
});

readline.on("close", () => {
  if (args.csv) {
    if (args.header) {
      console.log(
        "trial,requests received,responses 200,responses 500,dependency cache hits,dependency requests,dependency fallbacks,fallback,min latency,max latency,mean latency"
      );
    }
    console.log(
      [
        args.trial,
        requests,
        status[200],
        status[500],
        dependency.cacheHits,
        dependency.attempts,
        dependency.fallbacks,
        latency.min,
        latency.max,
        latency.total / requests
      ].join(",")
    );
  } else {
    const table = cTable.getTable([
      {
        trial: args.trial,
        "Req. Recieved": requests,
        "Res. (200)": `${status[200]} (${(status[200] / requests) * 100}%)`,
        "Res. (500)": `${status[500]} (${(status[500] / requests) * 100}%)`,
        "Dependency Cache Hits": `${
          dependency.cacheHits
        } (${(dependency.cacheHits / requests) * 100}%)`,
        "Dependency Req.": dependency.attempts,
        "Dependency Fallbacks": `${
          dependency.fallbacks
        } (${(dependency.fallbacks / requests) * 100}%)`,
        "Latency (min)": latency.min,
        "Latency (max)": latency.max,
        "Latency (mean)": latency.total / requests
      }
    ]);
    console.log(table);
  }
});
