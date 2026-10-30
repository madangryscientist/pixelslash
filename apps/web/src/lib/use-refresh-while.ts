import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

/** How often a page waiting on the explain queue reads itself again. */
const REFRESH_MS = 5_000;

/**
 * Reload the route's data every few seconds while `waiting` (ob 1875): the model's notes and the
 * summary arrive after the page was drawn, written by the explain queue's consumer.
 */
export function useRefreshWhile(waiting: boolean): void {
  const router = useRouter();
  useEffect(() => {
    const timer = waiting ? setInterval(() => void router.invalidate(), REFRESH_MS) : undefined;
    return () => clearInterval(timer);
  }, [waiting, router]);
}
