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
        tries += metrics.tries
    }
})

readline.on('close', () => {
    console.log('Requests:')
    console.log(`    received = ${requests}`)
    console.log(`    sent     = ${tries}`)
    console.log(`    200s     = ${successes} (${successes/requests}%)`)
    console.log('Latency:')
    console.log(`    min      = ${latency.min}`)
    console.log(`    max      = ${latency.max}`)
    console.log(`    mean     = ${latency.total/requests}`)
})
