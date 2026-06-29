import { Schema } from 'effect';

export const PlannerPhaseSchema = Schema.Literals(['ground', 'roads', 'objects']);
export type PlannerPhase = typeof PlannerPhaseSchema.Type;

export class PlannerError extends Schema.TaggedErrorClass<PlannerError>()(
  'PlannerError',
  {
    phase: PlannerPhaseSchema,
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  }
) {}

export function plannerError(
  phase: PlannerPhase,
  message: string,
  cause?: unknown
): PlannerError {
  return cause === undefined
    ? PlannerError.make({ phase, message })
    : PlannerError.make({ phase, message, cause });
}
