import type { Client, User } from "@workspace/db";

/** Shared by participant case/detail reads and participant notes. */
export function coordinatorCanAccessClient(
  user: Pick<User, "id" | "role">,
  client: Pick<Client, "assignedCoordinatorId">,
): boolean {
  return user.role !== "service_coordinator" || client.assignedCoordinatorId === user.id;
}
