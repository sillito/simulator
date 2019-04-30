import { Queue } from "./Queue";
import { DependencyRequest } from "../DependencyPool";

/**
 * Expects configuration:
 *  - maxSize: How large the queue should be
 *  - priorityProperty: the property on the request object to use to calculate the value
 */
export class PriorityQueue implements Queue<DependencyRequest> {
  public queue: Array<DependencyRequest>;

  private maxSize: number;
  private priorityProperty: string;

  constructor(config: any) {
    this.queue = [];
    this.maxSize = config.maxSize || 10;
    this.priorityProperty = config.priorityProperty || "value";
  }

  add(item: DependencyRequest): boolean {
    const priority = item.request[this.priorityProperty];
    let wasAdded = false;
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i].request[this.priorityProperty] > priority) {
        this.queue.splice(i, 0, item);
        wasAdded = true;
        break;
      }
    }

    // add to the end if not inserted into the queue.
    if (!wasAdded) {
      this.queue.push(item);
      wasAdded = !this.isFull();
    }

    // reject an existing item (the last one) if the queue is full
    if (this.isFull()) {
      const lowestPriority: DependencyRequest = this.queue.pop();
      lowestPriority.response.reject(new Error("Removed from Priority Queue"));
    }
    return wasAdded;
  }

  remove(): DependencyRequest {
    return this.queue.shift();
  }

  isFull() {
    return this.queue.length >= this.maxSize;
  }
}
