import { z } from 'zod';

export const ProfileMetadataSchema = z
  .object({
    id: z.string().min(1, 'Profile id is required'),
    description: z.string().optional(),
    extends: z.string().optional(),
    schemas: z.array(z.string()).optional(),
    agentsDir: z.string().optional().default('agents'),
    skillsDir: z.string().optional().default('skills'),
    agents: z.array(z.string()).optional(),
    skills: z.array(z.string()).optional(),
    invariants: z.array(z.string()).optional(),
  })
  .strip();

export type ProfileMetadataInput = z.input<typeof ProfileMetadataSchema>;
export type ProfileMetadataOutput = z.output<typeof ProfileMetadataSchema>;

/**
 * JSON Schema representation for build-time artifact generation.
 *
 * Zod 4 emits JSON Schema itself. `zod-to-json-schema` is typed against the
 * Zod 3 schema classes and silently converts a v4 object to `{}`, so it can no
 * longer be used here. `io: 'input'` describes what a profile author may write,
 * where a field carrying a default stays optional.
 */
export const ProfileMetadataJsonSchema = z.toJSONSchema(ProfileMetadataSchema, {
  target: 'draft-7',
  io: 'input',
  unrepresentable: 'any',
});
