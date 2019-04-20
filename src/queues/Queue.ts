export interface Queue<T> {
  // Insert an item in the queue
  add(item: T): boolean;

  // Get whats next in the queue
  remove(): T;
}
