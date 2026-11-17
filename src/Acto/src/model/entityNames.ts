/**
 * The entity-name rule, mirrored from `Messaging.Contracts.EntityNames.Format`:
 * `{name}_{version}-{suffix}`, where the suffix is the id's last two groups ("D" format, lower case).
 * It is the name the logs and the processors use, so the studio shows the same one. An id that is
 * not a GUID is used whole.
 */
export function entityName(name: string, version: string, id: string): string {
  return `${name}_${version}-${suffix(id)}`;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// "D" is 8-4-4-4-12; index 19 starts the fourth group.
function suffix(id: string): string {
  return GUID.test(id) ? id.slice(19).toLowerCase() : id;
}
