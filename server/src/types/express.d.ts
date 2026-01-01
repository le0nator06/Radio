import 'express';

declare global {
  namespace Express {
    interface User {
      id: string;
      displayName: string;
      avatar?: string;
      isAdmin?: boolean;
    }
  }
}

export {};
