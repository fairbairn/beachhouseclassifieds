import { createClientGuard } from "@/core/client/guard/client-guard";
import {
  reportClientGuardError,
  reportClientGuardRecovered,
} from "@/core/client/guard/client-guard-errors";

const guard = createClientGuard({
  reportClientGuardError,
  reportClientGuardRecovered,
});

export const clientGuard = guard.clientGuard;
