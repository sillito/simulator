const http = require('http')

require('timers')

//
// configure service using command line arguments, and these defaults
//
require('process')
var args = require('minimist')(process.argv.slice(2), {"default": {
    "name":"s1",
    "port":3000,
    "hostname":'127.0.0.1',
    "mean":200,
    "std":50,
    "failure_rate":0.01,
    "failure_mean":100,
    "failure_std":25,
    "response_size": 1024 * 1024,
    "failure_response_size": 512
}})

function usage() {
    //
    // print a (hopefully) informative usage message
    //
    console.log("USAGE: node simulator.js ARGS")
    console.log("\t--usage\t\tprint this message")
    console.log("\t--name <name>\ta name for this service name")
    console.log("\t--port <port to listen on>")
    console.log("\t--hostname <service hostname>")
    console.log("\nPerformance distribution (200s)")
    console.log("\t--mean <mean>")
    console.log("\t--std <standard deviation>")
    console.log("\t--response_size <bytes>")
    console.log("\nPerformance distribution (500s)")
    console.log("\t--failure_rate [0..1]")
    console.log("\t--failure_mean <mean>")
    console.log("\t--failure_std <standard deviation>")
    console.log("\t--failure_response_size <bytes>") 
}

//
// a running counter of the number of currently active requests
//
var connections_count = 0

//
// listen for requests, and respond with a status code, and response time 
// determined by a set of rules intended to simulate a real service
// 
const server = http.createServer((req, res) => {
    var start_time = Date.now()
    connections_count +=1 
    var start_connections = connections_count
    
    // TODO add support for reading the body of a POST request, before 
    // responding
    
    if (weighted_coin_toss(args.failure_rate)) {
        var wait_time = parseInt(normal_sample(args.failure_mean, 
            args.failure_std))
            res.statusCode = 500
        var body = Buffer.alloc(args.failure_response_size)
    }
    else {
        res.statusCode = 200
        var wait_time = parseInt(normal_sample(args.mean, args.std))
        var body = Buffer.alloc(args.response_size)
    }
    
    wait_time = Math.max(0, wait_time)
    
    res.on('finish', () => {
        var actual_time = Date.now() - start_time
        log([
            log_entry("status", res.statusCode),
            log_entry("start-cons", start_connections),
            log_entry("end-cons", connections_count),
            log_entry('sampled-ms', wait_time),
            log_entry("service-ms", actual_time),
            log_entry('overhead', actual_time-wait_time)])
        
        connections_count -= 1        
    })
    
    setTimeout(() => {
        res.setHeader('Content-Type', 'application/octet-stream')
        res.setHeader('Content-Length', body.byteLength)
        res.end(body)
    }, wait_time)
})

//
// logging facility (just logs to console, atm)
//
function log(messages) {
    console.log(messages.join(','))
}

function log_entry(name, value, units) {
    return `${name}=${value}${units||''}`
}

//
// functions for sampling from common distributions
//

function normal_sample(mean, std) {
	return standard_normal_sample() * std + mean
}

function standard_normal_sample() {
    //
    // Math.random() is a uniform distribution, we use the Box-Muller 
    // transform to get a normal distribution:
    // https://en.wikipedia.org/wiki/Box–Muller_transform
    // https://stackoverflow.com/questions/25582882
    //
    var u = 0, v = 0
    while(u === 0) u = Math.random() //Converting [0,1) to (0,1)
    while(v === 0) v = Math.random()
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v)
}

function weighted_coin_toss(weight) {
    //
    // returns true with probabilty 'weight' (in the interval [0..1]) and
    // false with probabilty '1-weight'
    //
    return Math.random() < weight
}

//
// main entry point, when service is called directly from command line
//

if (require.main === module) {
    if (args.usage) {
        usage()
        process.exit(1)
    }
    
    server.listen(args.port, args.hostname, () => {
        console.log(`Server running at http://${args.hostname}:${args.port}/`)
            
    })
}