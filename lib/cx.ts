/**
 * Joins class names, dropping anything falsy.
 *
 * CSS module lookups are typed through an index signature, so under
 * `noUncheckedIndexedAccess` every `styles.x` is possibly undefined. Template
 * literals would happily interpolate that as the string "undefined"; this will
 * not.
 */
export function cx(
  ...values: Array<string | false | null | undefined>
): string {
  return values.filter((value): value is string => Boolean(value)).join(" ");
}
