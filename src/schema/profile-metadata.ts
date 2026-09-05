import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

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

/** JSON Schema representation for build-time artifact generation */
export const ProfileMetadataJsonSchema = zodToJsonSchema(ProfileMetadataSchema, {
  name: 'ProfileMetadata',
});
