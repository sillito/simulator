import { DeferredPromise } from "./DeferredPromise";
import { Queue } from "./queues/Queue";
import { BoundedQueue } from "./queues/BoundedQueue";
import { PriorityQueue } from "./queues/PriorityQueue";
import { Req } from "./service";

export type DependencyRequest = {
  request: Req;
  service: string;
  requestFunction: DependencyRequestFunction;
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

/**
 * A DependencyPool is a Task Queue that sits in front of a pool
 * of active tasks (like a Thread Pool)
 */
export class DependencyPool {
  service: string;

  queue: Queue<DependencyRequest>;
  queueConfiguration;

  pool: DependencyRequest[];
  poolMaxSize: number;

  constructor(service, queueConfiguration, poolMaxSize) {
    this.service = service;
    this.queueConfiguration = queueConfiguration;

    switch (queueConfiguration.type) {
      case "PriorityQueue":
        this.queue = new PriorityQueue(queueConfiguration);
        break;
      default:
        this.queue = new BoundedQueue(queueConfiguration);
    }

    this.pool = [];
    this.poolMaxSize = poolMaxSize;
  }

  add(request: DependencyRequest): Promise<DependencyResponse> {
    const wasAdded = this.queue.add(request);
    if (!wasAdded) {
      return Promise.reject(new Error("Could not be added to the Queue"));
    }
    request.response = new DeferredPromise<DependencyResponse>();

    if (this.canWork()) {
      this.grabWork();
    }

    return request.response;
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

    request
      .requestFunction(request.service)
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
