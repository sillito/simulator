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
const http = require('http')
const url = require('url')

// 
// configure service using command line arguments, and these defaults
// 
var args = require('minimist')(process.argv.slice(2), {"default": {
    "name":"s1",
    "port":3000,
    "hostname":'127.0.0.1',
    "log_level":3,
    "mean":200,
    "std":50,
    "failure_rate":0.01,
    "failure_mean":100,
    "failure_std":25,
    "response_size": 1024 * 1024,
    "failure_response_size": 512,
    "services":[],
    "type":'timed',
    "max_tries":5, // global value for all dependencies, atm
    "timeout":200  // global value for all dependencies, atm
}})

function usage() {
    //
    // print a (hopefully) informative usage message
    //
    console.error("USAGE: node simulator.js ARGS")
    console.error("\t--usage\t\tprint this message")
    console.error("\t--name <name>\ta name for this service name")
    console.error("\t--port <port to listen on>")
    console.error("\t--hostname <service hostname>")
    console.error("\t--log_level [0...4]")
    console.error("\nPerformance distribution (200s)")
    console.error("\t--mean <mean>")
    console.error("\t--std <standard deviation>")
    console.error("\t--response_size <bytes>")
    console.error("\nPerformance distribution (500s)")
    console.error("\t--failure_rate [0..1]")
    console.error("\t--failure_mean <mean>")
    console.error("\t--failure_std <standard deviation>")
    console.error("\t--failure_response_size <bytes>")
    console.error("\nServices dependencies")
    console.error("\t--services <list of urls>")
    console.error("\t--type timed|serial|concurrent")
    console.error("\t--max_tries <number>")
    console.error("\t--timeout <number in ms>")
}

// a running counter of the number of currently active requests
var connections_count = 0
var fallback_count = 0


//
// Each request is assigned a request id (unless a request id is passed as part
// of the request's query string). ATM, this is just a simple one-up counter.
//
var _request_id = 0

function get_request_id(request) {
    var query = url.parse(request.url, true).query
    if (query.request_id) {
        return query.request_id
    }
    else {
        _request_id += 1
        return _request_id
    }
}

//
// Listen for requests, and respond with a status code, and response time 
// determined by a set of rules intended to simulate a real service
//
// TODO: add support for reading the body of a POST request, before taking
// action on the request
// 
const server = http.createServer((req, res) => {
    connections_count +=1
    fallback_count = 0
    var start_time = Date.now()
    var start_connections = connections_count
    var wait_time = 0

    var request_id = get_request_id(req)
    
    req.on('aborted', () => {
        log(DEBUG, `Request aborted ${Date.now()-start_time}ms (${wait_time}ms)`, request_id)
    })
    
    res.on('finish', () => {
        var actual_time = Date.now() - start_time
        log(DEBUG, `cons at start=${start_connections}, at end=${connections_count}`, request_id)
        log(DEBUG, `sampled ms=${wait_time}, actual ms=${actual_time}`, request_id)

        record_metrics(request_id, {
            status:res.statusCode,
            server_side_time: actual_time,
            fallback : fallback_count
        })
        
        connections_count -= 1
    })
    
    //
    // Handle this request based on the type flag we were configured 
    // with at start up
    //
    
    if (args.type === 'timed') {
        if (weighted_coin_toss(args.failure_rate)) {
            wait_time = parseInt(normal_sample(args.failure_mean, args.failure_std))
            setTimeout(() => {respond_500(res)}, wait_time)
        }
        else {
            wait_time = parseInt(normal_sample(args.mean, args.std))
            setTimeout(() => {respond_200(res)}, wait_time)
        }
    }
    else {
        var service_urls = args.services.split(',').map((service_url)=>{
            // TODO probably should use url module to construct this
            return `${service_url}/?request_id=${request_id}`
        })
        
        if (args.type === 'serial') {
            call_services_serially(request_id, service_urls, res)
        }
        else if (args.type === "concurrent") {
            call_services_concurrently(request_id, service_urls, res)
        }
        else {
            log(FATAL, `Unknown service type ${args.type}`)
        }
    }
})

function call_service(request_id, service_url, cb) {
    //
    // Call service_url and call cb with the status code when the service call
    // is complete.
    //
    var start_time = Date.now()
    make_request(service_url, (response, tries) => {
        record_metrics(request_id, {
            service:service_url, 
            status:response.statusCode,
            tries:tries,
            client_side_time:Date.now()-start_time,
            fallback:fallback_count
        })
        
        cb(response.statusCode)
    })
}

function make_request(service_url, cb) {
    //
    // Call service, retrying in the event of an error upu to a maximum of args.max_tries
    // attempts.
    //
    var attempts = 0
    
    var attempt = (e) => {
        attempts += 1
        
        if (e) {
            log(DEBUG, `Retry due to ${e.message} (${attempts} of ${args.max_tries})`)
        }
        
        if (attempts <= args.max_tries) {
            var seen_response = false // avoid retrying multiple times for same failure

            let request = http.request(service_url, response => {
                response.on('data', ()=>{})
                response.on('end', () => {
                    seen_response = true
                    if (response.statusCode === 500) { // retry on error response
                        fallback_count += 1
                        response.statusCode = 200
                        cb(response, attempts)//attempt({message:'500 status code'})
                    }
                    else {
                        cb(response, attempts)
                    }
                })
            })

            request.on('error', (e) => { // retry on any connection errors
                if (!seen_response) attempt(e)
            })
            
            request.setTimeout(args.timeout, () => { 
                request.socket.destroy() // this will trigger an error event
            })
    
            request.end()
        }
        else {
            fallback_count += 1
            cb({statusCode: 500}, attempts) // TODO: what should we do when we hit max_tries?
        }
    }
    
    attempt()
}

//
// The following two functions call each service in a list of service urls. The
// first calls all services concurrently, the second calls them serially. In 
// either case, if one of the services responds with a status code of 500, we 
// respond with a status code of 500, without waiting for all service calls.
//

function call_services_concurrently(request_id, service_urls, outgoing_response) {
    var complete_count = 0 // TODO might be worth logging this value on 500
    var completed = false // make sure we don't respond multiple times
    
    for (let service_url of service_urls) {
        call_service(request_id, service_url, (status) => {
            complete_count += 1            
            if (status === 500 && !completed) {
                fallback_count += 1
                // don't wait for other service calls, just return
                completed = true
                //respond_500(outgoing_response)
                respond_200(outgoing_response)
            }
            else if (complete_count === service_urls.length && !completed) {
                // all service calls are complete
                completed = true // I think this should be unnecessary, but ...
                respond_200(outgoing_response)
            }
        })
    }
}

function call_services_serially(request_id, service_urls, outgoing_response) {
    var service_url = service_urls.shift()
    
    if (service_url) {
        call_service(request_id, service_url, (status) => {
            if (status === 500) {
                fallback_count += 1
                //respond_500(outgoing_response) // recurssion base case 1
                respond_200(outgoing_response) // call 200 if 500 and log
            } 
            else {
                call_services_serially(request_id, service_urls, outgoing_response)
            }
        })
    } 
    else {
        respond_200(outgoing_response) // recurssion base case 2
    }
}

//
// This service always responds in one of two ways: 200 or 500
// 

function respond_200(response) {
    var body = Buffer.alloc(args.response_size)
    response.statusCode = 200

    response.setHeader('Content-Type', 'application/octet-stream')
    response.setHeader('Content-Length', body.byteLength)
    response.end(body)
}

function respond_500(response) {
    var body = Buffer.alloc(args.failure_response_size)
    response.statusCode = 500
    response.setHeader('Content-Type', 'application/octet-stream')
    response.setHeader('Content-Length', body.byteLength)
    response.end(body)
}

// 
// logging facility (just logs to console, atm)
// 

const DEBUG = 4, INFO = 3, WARN = 2, ERROR = 1, FATAL = 0
const LOG_LEVEL_NAMES = ["FATAL", "ERROR", "WARN", "INFO", "DEBUG"]

function log(level, message, request_id) {
    if (level <= args.log_level) {
        if (request_id===undefined) {
            console.error(`${LOG_LEVEL_NAMES[level]}: ${message}`)
        }
        else {
            console.error(`${LOG_LEVEL_NAMES[level]} ${request_id}: ${message}`)
        }
    }
}

function record_metrics(request_id, metrics) {
    // var metrics_string = Object.keys(metrics).map((k) => {
    //     return `${k}=${metrics[k]}`
    // }).join(',')
    // console.log(`request_id=${request_id},${metrics_string}`)
    metrics['request_id'] = request_id
    console.log(JSON.stringify(metrics))
}
//
// function log_entry(name, value, units) {
//     return `${name}=${value}${units||''}`
// }

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
    while(u === 0) u = Math.random() // converting [0,1) to (0,1)
    while(v === 0) v = Math.random()
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v)
}

function poisson_sample() {
    // TODO
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
        log(INFO, `Service running at http://${args.hostname}:${args.port}/`)
        log(DEBUG, `With args ${JSON.stringify(args)}`)
    })
}
