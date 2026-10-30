import { createServerFn } from "@tanstack/react-start";
import { googleConfig } from "./env";

/** Which sign-ins the page offers: GitHub always, Google when the deployment has a client (PS-274). */
export const getSignInOptions = createServerFn().handler(() => ({
  google: googleConfig() !== null,
}));
