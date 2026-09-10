import { expectTypeOf } from "vitest";
import { PERMISSIONS, RESULT_BAD, RESULT_OK, SESSION_MODES, SESSION_TRANSPORTS } from "../src/types.ts";

expectTypeOf(RESULT_OK).toEqualTypeOf<readonly ["success"]>();
expectTypeOf(RESULT_BAD).toEqualTypeOf<readonly ["error_max_turns", "error_during_execution"]>();
expectTypeOf(PERMISSIONS).toEqualTypeOf<readonly ["smart", "full", "off"]>();
expectTypeOf(SESSION_MODES).toEqualTypeOf<readonly ["default", "plan"]>();
expectTypeOf(SESSION_TRANSPORTS).toEqualTypeOf<readonly ["acp", "print"]>();
