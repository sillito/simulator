import { DeferredPromise } from "./DeferredPromise";
import { Queue } from "./queues/Queue";
import { BoundedQueue } from "./queues/BoundedQueue";
import { PriorityQueue } from "./queues/PriorityQueue";
import { Req } from "./service";

// The Object type that is added to queues
export type DependencyRequest = {
  request: Req;
  //service: string;
  //requestFunction: DependencyRequestFunction;
  response?: DeferredPromise<DependencyResponse>;
};

export type DependencyCallback = (error?: any, value?: any) => void;

export type DependencyRequestFunction = (
  service: string,
  attempt?: number,
  error?: any
) => Promise<DependencyResponse>;

export type DependencyResponse = {
  response: {
    statusCode: number;
  };
  attempt: number;
};

export type Dependency = {
  service: string;

  workers: number;
  queue: QueueConfig;
};
type QueueConfig = {
  type: string;
  maxSize: number;
  [key: string]: any;
};

/**
 * A DependencyPool is a Task Queue that sits in front of a pool
 * of active tasks (like a Thread Pool)
 */
export class DependencyPool {
  dependency: Dependency;
  requestFunction: DependencyRequestFunction;

  queue: Queue<DependencyRequest>;
  pool: DependencyRequest[];
  poolMaxSize: number;

  constructor(
    dependency: Dependency,
    requestFunction: DependencyRequestFunction
  ) {
    this.requestFunction = requestFunction;

    switch (dependency.queue.type) {
      case "PriorityQueue":
        this.queue = new PriorityQueue(dependency.queue);
        break;
      default:
        this.queue = new BoundedQueue(dependency.queue);
    }

    this.pool = [];
    this.poolMaxSize = dependency.workers;
  }

  async fallback(request: Req): Promise<number> {
    // call fallback, return value
    return 200;
  }

  add(request: Req): Promise<DependencyResponse> {
    const dependencyRequest: DependencyRequest = {
      request,
      response: new DeferredPromise<DependencyResponse>()
    };
    const wasAdded = this.queue.add(dependencyRequest);
    if (!wasAdded) {
      return Promise.reject(
        new Error("Could not be added to the Queue. " + request.requestId)
      );
    }

    if (this.canWork()) {
      this.grabWork();
    }

    return dependencyRequest.response;
  }

  private canWork() {
    return this.pool.length < this.poolMaxSize;
  }
  private grabWork() {
    const first = this.queue.remove();
    if (first) {
      this.workOn(first);
    }
  }
  private workOn(request: DependencyRequest) {
    //console.error("Working on Request");
    this.pool.push(request);

    this.requestFunction(this.dependency.service)
      .then(response => {
        //console.error("Finished Working on Request");
        // complete the response by notifying the request that it has finished
        request.response.resolve(response);

        // remove from pool
        this.pool.splice(this.pool.indexOf(request), 1);

        // grab from queue.
        this.grabWork();
      })
      .catch(err => {
        //console.error("Error Working on Request");
        // complete the response by notifying the request that it has finished
        request.response.reject(err);

        // remove from pool
        this.pool.splice(this.pool.indexOf(request), 1);

        // grab from queue.
        this.grabWork();
      });
  }
}
