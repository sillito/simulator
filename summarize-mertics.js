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
var tries = 0;
var requests = 0;
var successes = 0;
var latency = {
  total: 0,
  min: Number.MAX_VALUE,
  max: 0
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

  if (metrics.serverSideTime) {
    // metrics line about the total service time
    requests += 1;
    latency.total += metrics.serverSideTime;
    if (metrics.serverSideTime < latency.min) {
      latency.min = metrics.serverSideTime;
    }
    if (metrics.serverSideTime > latency.max) {
      latency.max = metrics.serverSideTime;
    }
    if (metrics.status == 200) {
      successes += 1;
    }
  } else {
    // metrics line from calling a dependency
    tries += metrics.tries || 0;
  }
});

readline.on("close", () => {
  if (args.csv) {
    if (args.header) {
      console.log(
        "trial,requests received,requests sent,successes returned,min latency,max latency,mean latency"
      );
    }
    console.log(
      [
        args.trial,
        requests,
        tries,
        successes,
        latency.min,
        latency.max,
        latency.total / requests
      ].join(",")
    );
  } else {
    const table = cTable.getTable([
      {
        trial: args.trial,
        "Requests Recieved": requests,
        "Requests Sent (tries)": tries,
        "Responses (200)": successes,
        "Latency (min)": latency.min,
        "Latency (max)": latency.max,
        "Latency (mean)": latency.total / requests
      }
    ]);
    console.log(table);
  }
});
