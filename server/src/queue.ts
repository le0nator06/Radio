import { randomUUID } from 'crypto';

export interface Track {
  id: string;
  url: string;
  title: string;
  thumbnail?: string;
  duration?: number;
  startedAt?: number;
  source: 'youtube' | 'soundcloud';
  requestedBy: {
    id: string;
    displayName: string;
    avatar?: string;
  };
}

export class TrackQueue {
  private readonly queue: Track[] = [];

  enqueue(payload: Omit<Track, 'id'>): Track {
    const track: Track = { id: randomUUID(), ...payload };
    this.queue.push(track);
    return track;
  }

  dequeue(): Track | undefined {
    return this.queue.shift();
  }

  peek(): Track | undefined {
    return this.queue[0];
  }

  snapshot(): Track[] {
    return [...this.queue];
  }

  clear(): void {
    this.queue.length = 0;
  }

  size(): number {
    return this.queue.length;
  }

  remove(trackId: string): boolean {
    const index = this.queue.findIndex((t) => t.id === trackId);
    if (index === -1) {
      return false;
    }
    this.queue.splice(index, 1);
    return true;
  }

  move(trackId: string, newIndex: number): boolean {
    const currentIndex = this.queue.findIndex((t) => t.id === trackId);
    if (currentIndex === -1) {
      return false;
    }
    const clampedIndex = Math.max(0, Math.min(newIndex, this.queue.length - 1));
    const [track] = this.queue.splice(currentIndex, 1);
    this.queue.splice(clampedIndex, 0, track);
    return true;
  }
}
