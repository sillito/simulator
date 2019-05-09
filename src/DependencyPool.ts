import { DeferredPromise } from "./DeferredPromise";
import { Queue } from "./queues/Queue";
import { BoundedQueue } from "./queues/BoundedQueue";
import { PriorityQueue } from "./queues/PriorityQueue";
import { Req } from "./service";
import * as path from "path";

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
  name: string;
  service: string;

  workers: number;
  queue: QueueConfig;
  fallback: Fallback;
};
type Fallback = {
  type: "function" | "dependency";
  function?: string;
  dependency?: Dependency;
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
  fallbackFunction: Function;

  queue: Queue<DependencyRequest>;
  pool: DependencyRequest[];
  workers: number;

  constructor(
    dependency: Dependency,
    requestFunction: DependencyRequestFunction
  ) {
    this.dependency = dependency;
    this.requestFunction = requestFunction;

    switch (dependency.queue.type) {
      case "PriorityQueue":
        this.queue = new PriorityQueue(dependency.queue);
        break;
      default:
        this.queue = new BoundedQueue(dependency.queue);
    }

    this.pool = [];
    this.workers = dependency.workers;

    this.createFallback(dependency.fallback);
  }

  /**
   * A fallback can be either a function or a dependency.
   * Case 1) Function:
   *  Parse `function` as filePath#functionName.
   *  Function must exist as async function(service, request): Promise<number>
   *
   * Case 2) Dependency
   *
   *
   */
  private createFallback(fallback: Fallback) {
    if (!fallback) {
      return;
    }

    switch (fallback.type) {
      case "function":
        this.fallbackFunction = this.parseFallbackFunction(fallback.function);
        break;
      case "dependency":
        this.fallbackFunction = this.createDependencyFallbackFunction(
          fallback.dependency
        );
        break;
    }
  }

  private createDependencyFallbackFunction(
    fallbackDependency: Dependency
  ): Function {
    const fallbackPool = new DependencyPool(
      fallbackDependency,
      this.requestFunction
    );

    return async function(service, request): Promise<number> {
      // here is place for circuit breaker

      // Queue
      let fallbackResponse: DependencyResponse;
      try {
        fallbackResponse = await fallbackPool.add(request);
      } catch (err) {
        let x = await fallbackPool.fallback(request);
        return x;
      }

      // call the actual service
      const { response, attempt } = fallbackResponse;
      let status = response.statusCode;

      // Account for fallback, if execution fails.
      const shouldFallback = fallbackDependency.fallback && status == 500;

      if (shouldFallback) {
        status = await fallbackPool.fallback(request);
      }

      return response.statusCode;
    };
  }
  private parseFallbackFunction(fallback): Function {
    if (!fallback) {
      return undefined;
    }
    const file = fallback.split("#")[0];
    const func = fallback.split("#")[1];
    const fallbackPath = path.join(__dirname, file);
    let target;
    try {
      target = require(fallbackPath);
    } catch (err) {
      throw new Error(`Could not find a fallback at ${fallbackPath}`);
    }
    if (typeof target[func] != "function") {
      throw new Error(
        `Could not load the fallback function (${fallback}) for this dependency.`
      );
    }
    return target[func];
  }

  async fallback(request: Req): Promise<number> {
    if (this.fallbackFunction) {
      return this.fallbackFunction(this, request);
    }
    return 500;
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

    //console.error("XXXXXXXXXXX", this.canWork());

    if (this.canWork()) {
      this.grabWork();
    }

    return dependencyRequest.response;
  }

  private canWork() {
    return this.pool.length <= this.workers;
  }
  private grabWork() {
    const first = this.queue.remove();
    if (first) {
      this.workOn(first);
    }
  }
  private workOn(request: DependencyRequest) {
    this.pool.push(request);
    this.requestFunction(this.dependency.service)
      .then(response => {
        this;
        //console.error("Finished Working on Request", request);
        // complete the response by notifying the request that it has finished
        request.response.resolve(response);

        // remove from pool
        this.pool.splice(this.pool.indexOf(request), 1);

        // grab from queue.
        this.grabWork();
      })
      .catch(err => {
        //console.error("Error Working on Request", err);
        // complete the response by notifying the request that it has finished
        request.response.reject(err);

        // remove from pool
        this.pool.splice(this.pool.indexOf(request), 1);

        // grab from queue.
        this.grabWork();
      });
  }
}
