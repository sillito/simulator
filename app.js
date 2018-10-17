// 
// TODO implement a simple app that will do just the following:
// * listen for HTTP requests on a configurable port
// * for each request:
//   * assign it a unique request ID
//   * calls one dependent service (at a configurable id and port), passing the
//     unique request id
//   * when the service responds grab the status code
//   * responds to request with same status code as dependent service
//
// TODO for each request log the following:
// * the request id
// * the status code
// * the overall time taken
// * the time spent waiting for the dependent service
//

