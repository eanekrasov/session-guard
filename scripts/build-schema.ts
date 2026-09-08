/**
 * Write the JSON Schemas the editor uses to validate profile files.
 *
 * These used to be two `bun -e` one-liners inside a package.json script. They
 * moved here when the scripts block did: a shell task cannot carry that much
 * quoting without becoming unreadable, and a file can say what it produces.
 */
import { writeFileSync } from 'node:fs';
import { ProfileMetadataJsonSchema } from '../src/schema/profile-metadata.ts';
import { ProfileSchemaJsonSchema } from '../src/schema/profile-schema.ts';

writeFileSync('dist/profile.schema.json', JSON.stringify(ProfileMetadataJsonSchema, null, 2));
writeFileSync('dist/profile-schema.schema.json', JSON.stringify(ProfileSchemaJsonSchema, null, 2));
