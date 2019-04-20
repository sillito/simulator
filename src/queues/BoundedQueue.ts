import { Queue } from "./Queue";

export class BoundedQueue<T> implements Queue<T> {
  private queue: Array<T>;

  private maxSize: number;

  constructor(config: any) {
    this.queue = [];
    this.maxSize = config.maxSize || 10;
  }

  add(item: T): boolean {
    if (this.isFull()) {
      return false;
    }
    return !!this.queue.push(item);
  }

  remove(): T {
    return this.queue.shift();
  }

  isFull() {
    return this.queue.length >= this.maxSize;
  }
}
