export interface UserAuth {
  getUserId(): string;
  canRead(projectId: string): boolean;
  canWrite(projectId: string): boolean;
}

export const devUserAuth: UserAuth = {
  getUserId: () => 'admin',
  canRead: (projectId: string) => true,
  canWrite: (projectId: string) => true,
};
