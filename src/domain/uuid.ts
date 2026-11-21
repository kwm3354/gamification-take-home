const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for the canonical 36-character form only. PostgreSQL rejects anything else with an error. */
export const isUuid = (value: string): boolean => UUID.test(value);
