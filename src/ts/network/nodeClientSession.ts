import { v4 as uuidv4 } from "uuid";

const nodeClientSessionId = uuidv4();

export function getNodeClientSessionId(): string {
  return nodeClientSessionId;
}
