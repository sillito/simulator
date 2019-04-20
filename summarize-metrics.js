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
    const decimals = 2;
    const res200Percent = (status[200] / requests) * 100;
    const res500Percent = (status[500] / requests) * 100;
    const cacheHitsPercent = (dependency.cacheHits / requests) * 100;
    const fallbackPercent = (dependency.fallbacks / requests) * 100;
    const meanLatency = latency.total / requests;
    const table = cTable.getTable([
      {
        trial: args.trial,
        "Req. Recieved": requests,
        "Res. (200)": `${status[200]} (${res200Percent.toFixed(decimals)}%)`,
        "Res. (500)": `${status[500]} (${res500Percent.toFixed(decimals)}%)`,
        "Dependency Cache Hits": `${
          dependency.cacheHits
        } (${cacheHitsPercent.toFixed(decimals)}%)`,
        "Dependency Req.": dependency.attempts,
        "Dependency Fallbacks": `${
          dependency.fallbacks
        } (${fallbackPercent.toFixed(decimals)}%)`,
        "Latency (min)": latency.min,
        "Latency (max)": latency.max,
        "Latency (mean)": meanLatency.toFixed(2)
      }
    ]);
    console.log(table);
  }
});
