//
// Read JSON format metrics from stdin and produce a summary of the experiment, which
// includes latency (min, max and mean), availability (ie, % of 200 responses) number
// of and requests and number of tries to get a response from a dependent service.
//
// TODO: Really we care about the latency distribution, not just the min, max and mean
//
import * as fs from "fs";
const readline = require("readline").createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});
const cTable = require("console.table");

var args = require("minimist")(process.argv.slice(2), {
  default: {
    name: "trial",
    csv: false,
    header: false,
    wrkReport: null
  }
});

type Metric = {
  lines: any[];
  requestsToDependency: number;
  requestsToDependencyFallback: number;
  [key: string]: any;
};

type MetricDictionary = { [requestId: number]: Metric };

let requests: MetricDictionary = {};

// shove all requests into a dictionary keyed on requestId
readline.on("line", line => {
  const record = JSON.parse(line);
  const requestLine = record.request;

  if (!requests[requestLine.requestId]) {
    requests[requestLine.requestId] = {
      lines: [record],
      requestsToDependency: 0,
      requestsToDependencyFallback: 0
    };
  } else {
    requests[requestLine.requestId].lines.push(record);
  }
});

readline.on("close", () => {
  let m = null;
  try {
    m = generateMetrics();
  } catch (err) {
    console.error("ERROR IN SUMMARIZE", err);
    throw err;
  }
  if (args.csv) {
    if (args.header) {
      console.log(
        "trial,requests received,responses 200,responses 500,dependency cache hits,dependency requests,dependency fallbacks,fallback,min latency,max latency,mean latency"
      );
    }
    console.log(
      [
        args.name,
        m.service.requests,
        m.service.responseStatuses[200],
        m.service.responseStatuses[500],
        m.dependencyCounter.cacheHits,
        m.dependencyCounter.tries,
        m.dependencyCounter.fallbacks,
        m.service.latency.min,
        m.service.latency.max,
        m.service.latency.total / m.service.requests
      ].join(",")
    );
  } else {
    const decimals = 2;
    const res200Percent =
      (m.service.responseStatuses[200] / m.service.requests) * 100;
    const res500Percent =
      (m.service.responseStatuses[500] / m.service.requests) * 100;
    const cacheHitsPercent =
      (m.dependencyCounter.cacheHits / m.dependencyCounter.requests) * 100;
    const fallbackPercent =
      (m.dependencyCounter.fallbacks / m.dependencyCounter.requests) * 100;
    const meanLatency = m.service.latency.total / m.service.requests;
    const table = cTable.getTable([
      {
        trial: args.name,
        "Req. Recieved": m.service.requests,
        "Res. (200)": `${
          m.service.responseStatuses[200]
        } (${res200Percent.toFixed(decimals)}%)`,
        "Res. (500)": `${
          m.service.responseStatuses[500]
        } (${res500Percent.toFixed(decimals)}%)`,
        "Dependency Cache Hits": `${
          m.dependencyCounter.cacheHits
        } (${cacheHitsPercent.toFixed(decimals)}%)`,
        "Dependency Req.": m.dependencyCounter.tries,
        "Dependency Fallbacks": `${
          m.dependencyCounter.fallbacks
        } (${fallbackPercent.toFixed(decimals)}%)`,
        "Latency (min)": m.service.latency.min,
        "Latency (max)": m.service.latency.max,
        "Latency (mean)": meanLatency.toFixed(2)
      }
    ]);
    console.log(table);
  }
});

function generateMetrics() {
  // strip aborts, caused by closing connections in WRK
  const report = fs.readFileSync(args.wrkReport, { encoding: "utf8" });
  const truncateAfter = parseInt(
    /(\d*) requests in /g.exec(report.toString())[1]
  );
  // console.error("TRUNCATE AFTER", truncateAfter);
  const service = {
    requests: 0,
    responseStatuses: {
      200: 0,
      500: 0
    },
    latency: {
      min: Number.MAX_VALUE,
      max: 0,
      total: 0
    }
  };
  const dependencyCounter = {
    cacheHits: 0,
    fallbacks: 0,
    requests: 0,
    tries: 0,
    responseStatuses: {
      200: 0,
      500: 0
    },
    latency: {
      min: Number.MAX_VALUE,
      max: 0,
      total: 0
    }
  };
  const metrics = Object.values(requests);
  for (var i = 0; i < metrics.length; i++) {
    const metric = metrics[i];
    const lines = metric.lines;
    if (!lines.find(line => line.elapsedTime)) {
      //console.error("REMOVED", lines, "since no elapsedTime");
      continue;
    }

    // filter aborted requests caused by hangups from wrk

    lines.forEach(line => {
      if (line.dependency) {
        dependencyCounter.requests++;
        dependencyCounter.responseStatuses[line.status]++;

        dependencyCounter.latency.total += line.dependencyTime;
        dependencyCounter.latency.min = Math.min(
          line.dependencyTime,
          dependencyCounter.latency.min
        );
        dependencyCounter.latency.max = Math.max(
          line.dependencyTime,
          dependencyCounter.latency.max
        );

        dependencyCounter.cacheHits += line.cache ? 1 : 0;
        dependencyCounter.fallbacks += line.fallback ? 1 : 0;
        dependencyCounter.tries += line.tries;
      } else {
        service.requests++;
        service.responseStatuses[line.status]++;

        service.latency.total += line.elapsedTime;
        service.latency.min = Math.min(line.elapsedTime, service.latency.min);
        service.latency.max = Math.max(line.elapsedTime, service.latency.max);
      }
    });
  }

  return {
    service,
    dependencyCounter
  };
}
