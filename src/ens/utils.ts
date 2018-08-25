import { toAscii } from "idna-uts46-hx";
import { sha3, anyToHex } from "../shared";

const SEPARATOR = ".";

function normalize(name: string): string {
  name = toAscii(name, {
    transitional: true,
    useStd3ASCII: true,
  });

  if (name) {
    name
      .split(SEPARATOR)
      .filter((value) => !!value)
      .join(SEPARATOR);
  }

  return name || null;
}

/**
 * prepares ens mame
 * @param parts
 */
export function prepareEnsName(...parts: string[]): string {
  return normalize(parts.join(SEPARATOR));
}

/**
 * splits ens name
 * @param name
 */
export function splitEnsName(name: string): {
  label: string;
  rootNodeName: string;
} {
  let label: string = null;
  let rootNodeName: string = null;

  if (name) {
    const parts = name.split(SEPARATOR);
    if (parts.length > 1) {
      label = parts[ 0 ];
      rootNodeName = parts.slice(1).join(SEPARATOR);
    }
  }

  return {
    label,
    rootNodeName,
  };
}

/**
 * gets ens name hash
 * @param name
 */
export function getEnsNameHash(name: string): string {
  let result: string = null;

  if (name) {
    let node = Buffer.alloc(32, 0);
    const parts = name
      .split(SEPARATOR)
      .map((part) => sha3(part))
      .reverse();

    for (const part of parts) {
      node = sha3(node, part);
    }

    result = anyToHex(node, { add0x: true });
  }

  return result;
}

/**
 * gets ens label hash
 * @param label
 */
export function getEnsLabelHash(label: string): string {
  let result: string = null;

  if (label) {
    result = anyToHex(sha3(label), { add0x: true });
  }

  return result;
}
