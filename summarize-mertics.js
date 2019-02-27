//
// Read JSON format metrics from stdin and produce a summary of the experiment, which 
// includes latency (min, max and mean), availability (ie, % of 200 responses) number 
// of and requests and number of tries to get a response from a dependent service.
//
// TODO: Really we care about the latency distribution, not just the min, max and mean
//
const process = require("process")
const readline = require('readline').createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
})
const cTable = require('console.table');

//
// Metrics to report
//
var tries = 0
var requests = 0
var successes = 0
var latency = {
    total:0,
    min:Number.MAX_VALUE,
    max:0
}

var args = require('minimist')(process.argv.slice(2), {"default": {
    "trial":0,
    "csv":false,
    "header":false 
}})

readline.on('line', (line) => {
    let metrics = JSON.parse(line)
    
    if (metrics.server_side_time) {
        // metrics line about the total service time
        requests += 1
        latency.total += metrics.server_side_time
        if (metrics.server_side_time < latency.min) {
            latency.min = metrics.server_side_time
        }
        if (metrics.server_side_time > latency.max) {
            latency.max = metrics.server_side_time
        }
        if (metrics.status == 200) {
            successes += 1
        }
    }
    else {
        // metrics line from calling a dependency
        tries += metrics.tries || 0
    }
})

readline.on('close', () => {
    if (args.csv) {
        if (args.header) {
            console.log('trial,requests received,requests sent,successes returned,min latency,max latency,mean latency')
        }
        console.log([args.trial,requests, tries, successes,latency.min,latency.max,latency.total/requests].join(','))
    }
    else {
        const table = cTable.getTable([{
            trial: args.trial,
            recieved: requests,
            sent: tries,
            returned_200s: successes,
            min_latency: latency.min,
            max_latency: latency.max,
            mean_latency: latency.total/requests
        }, ]);
        console.log(table);
    }
})
