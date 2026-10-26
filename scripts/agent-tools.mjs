// scripts/agent-tools.mjs — Pure functions for building MCP Agent Tools registry.
// Shared by scripts/gen-commands.mjs and unit tests (scripts/agent-tools.test.mjs).

export const RUST_TYPE_OVERRIDES = {
  'note_query.region': 'crate::commands::notes::NoteQueryRegionArg',
  'note_query.coords': 'crate::commands::notes::NoteQueryCoordsArg',
  'ai_get_history.limit': 'usize',
  'pet_chat_history.limit': 'usize',
  'pet_conversation_save.messages': 'Vec<crate::commands::pet::PetConversationMessageInput>',
  'space_bootstrap.items': 'Vec<crate::models::SpaceItemSeed>',
  'space_items_move.moves': 'Vec<crate::models::SpaceItemMove>',
  'space_relation_save.nodes': 'Vec<crate::models::SpaceNodeInput>',
  'space_relation_save.edges': 'Vec<crate::models::SpaceEdgeInput>',
};

export function parseRustField(cmdName, fieldName, rawType, overrides = RUST_TYPE_OVERRIDES) {
  const override = overrides && overrides[`${cmdName}.${fieldName}`];
  let str = String(rawType).trim();
  let optional = false;
  let omitDefault;

  const omitIdx = str.indexOf('|omit');
  if (omitIdx !== -1) {
    optional = true;
    const omitPart = str.slice(omitIdx + 5);
    if (omitPart.startsWith('=')) {
      omitDefault = omitPart.slice(1);
    }
    str = str.slice(0, omitIdx);
  }
  if (str.endsWith('?')) {
    optional = true;
    str = str.slice(0, -1);
  }
  if (str.includes('|null')) {
    optional = true;
    str = str.replace('|null', '');
  }

  let range;
  const rangeMatch = str.match(/\((-?\d+)\.\.(-?\d+)\)$/);
  if (rangeMatch) {
    range = {
      minimum: parseInt(rangeMatch[1], 10),
      maximum: parseInt(rangeMatch[2], 10),
    };
  }
  str = str.replace(/\([^)]*\)$/, '').trim(); // strip trailing range annotation e.g. integer(1..12)

  let enumValues;
  if (str.startsWith("'")) {
    const parts = str.split('|').map(s => s.trim());
    if (parts.length > 0 && parts.every(p => p.startsWith("'") && p.endsWith("'"))) {
      enumValues = parts.map(p => p.slice(1, -1));
    }
  }

  if (override) return { optional, rust: override, enumValues, omitDefault, range };

  let rust;
  const mapMatch = str.match(/^map<([^,]+),\s*(.+)>$/);
  if (mapMatch) {
    const v = mapMatch[2].trim();
    const vRust = v === 'json' ? 'serde_json::Value' : parseRustField(cmdName, fieldName, v, overrides).rust;
    rust = `std::collections::BTreeMap<String, ${vRust}>`;
  } else if (str.endsWith('[]')) {
    rust = `Vec<${parseRustField(cmdName, fieldName, str.slice(0, -2), overrides).rust}>`;
  } else if (str.startsWith("'")) {
    rust = 'String'; // literal union — the command fn validates the allowed values itself
  } else if (fieldName === 'lat' || fieldName === 'lng') {
    rust = 'f64'; // DSL has no float type; this codebase always stores lat/lng as REAL/f64
  } else if (str === 'uuid' || str === 'string' || str === 'timestamp' || str === 'iso8601') {
    rust = 'String';
  } else if (str === 'integer') {
    rust = 'i64';
  } else if (str === 'number') {
    rust = 'f64';
  } else if (str === 'boolean') {
    rust = 'bool';
  } else if (str === 'json') {
    throw new Error(
      `dispatch codegen: no RUST_TYPE_OVERRIDES entry for json field "${cmdName}.${fieldName}" — ` +
      `add one, or mark ${cmdName} \`http: false\` in its spec file.`
    );
  } else {
    throw new Error(`dispatch codegen: cannot map input type for ${cmdName}.${fieldName}: "${rawType}"`);
  }
  return { optional, rust, enumValues, omitDefault, range };
}

export function cliType(rust) {
  if (rust.startsWith('Vec<')) return { type: 'array', item: cliType(rust.slice(4, -1)).type };
  if (rust.startsWith('std::collections::BTreeMap')) return { type: 'json' };
  if (rust.startsWith('crate::')) return { type: 'json' };
  if (rust === 'String') return { type: 'string' };
  if (rust === 'i64' || rust === 'usize') return { type: 'integer' };
  if (rust === 'f64') return { type: 'number' };
  if (rust === 'bool') return { type: 'boolean' };
  throw new Error(`cli codegen: unmapped rust type "${rust}"`);
}

export function buildAgentTools(allCommands, options = {}) {
  const overrides = options.overrides || RUST_TYPE_OVERRIDES;
  const tools = [];

  for (const [cmdName, spec] of Object.entries(allCommands)) {
    if (!spec || !spec.agent) continue;

    // Rule 1: agent attached to http: false command
    if (spec.http === false) {
      throw new Error(`agent: cannot attach agent block to http:false command "${cmdName}"`);
    }

    // Rule 2: kind is not read or write
    if (spec.agent.kind !== 'read' && spec.agent.kind !== 'write') {
      throw new Error(`agent: kind must be 'read' or 'write', got "${spec.agent.kind}" for command "${cmdName}"`);
    }

    // Rule 3: description is empty or missing
    if (!spec.agent.description || typeof spec.agent.description !== 'string' || spec.agent.description.trim() === '') {
      throw new Error(`agent: description is empty or missing for command "${cmdName}"`);
    }

    const inputObj = (spec.input && typeof spec.input === 'object') ? spec.input : {};
    const inputKeys = new Set(Object.keys(inputObj));

    // Rule 4: args or hide keys not in input
    if (spec.agent.args && typeof spec.agent.args === 'object') {
      for (const k of Object.keys(spec.agent.args)) {
        if (!inputKeys.has(k)) {
          throw new Error(`agent: args key "${k}" does not exist in input for command "${cmdName}"`);
        }
      }
    }
    const hideList = Array.isArray(spec.agent.hide) ? spec.agent.hide : [];
    for (const k of hideList) {
      if (!inputKeys.has(k)) {
        throw new Error(`agent: hide key "${k}" does not exist in input for command "${cmdName}"`);
      }
    }

    const hideSet = new Set(hideList);

    // Rule 5: hide refers to a required arg
    for (const k of hideList) {
      const parsed = parseRustField(cmdName, k, inputObj[k], overrides);
      if (!parsed.optional) {
        throw new Error(`agent: hide cannot hide required argument "${k}" in command "${cmdName}"`);
      }
    }

    // Rule 6: json type arg is neither hidden (hide) nor described (args)
    const argsMap = (spec.agent.args && typeof spec.agent.args === 'object') ? spec.agent.args : {};
    for (const f of Object.keys(inputObj)) {
      if (hideSet.has(f)) continue;
      const parsed = parseRustField(cmdName, f, inputObj[f], overrides);
      const ct = cliType(parsed.rust);
      if (ct.type === 'json') {
        const isDescribed = Boolean(argsMap[f] && typeof argsMap[f] === 'string' && argsMap[f].trim() !== '');
        if (!isDescribed) {
          throw new Error(`agent: json argument "${f}" in command "${cmdName}" must be hidden (hide) or described (args)`);
        }
      }
    }

    // Build Tool Schema
    const properties = {};
    const required = [];

    for (const f of Object.keys(inputObj)) {
      if (hideSet.has(f)) continue;

      const parsed = parseRustField(cmdName, f, inputObj[f], overrides);
      const ct = cliType(parsed.rust);

      const prop = {};
      if (ct.type === 'array') {
        prop.type = 'array';
        prop.items = { type: ct.item };
      } else if (ct.type === 'json') {
        // Tagged union or custom json argument
      } else {
        prop.type = ct.type;
      }

      if (parsed.enumValues) {
        prop.enum = parsed.enumValues;
      }
      if (parsed.range) {
        prop.minimum = parsed.range.minimum;
        prop.maximum = parsed.range.maximum;
      }

      let desc = argsMap[f] ? argsMap[f].trim() : '';
      if (parsed.omitDefault) {
        const suffix = `(생략 시: ${parsed.omitDefault})`;
        if (!desc) {
          desc = suffix;
        } else if (!desc.includes(suffix)) {
          desc = `${desc} ${suffix}`;
        }
      }
      if (desc) {
        prop.description = desc;
      }

      if (!parsed.optional) {
        required.push(f);
      }

      properties[f] = prop;
    }

    const annotations = spec.agent.kind === 'read'
      ? { readOnlyHint: true, openWorldHint: false }
      : { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

    tools.push({
      name: cmdName,
      description: spec.agent.description.trim(),
      inputSchema: {
        type: 'object',
        properties,
        required,
        additionalProperties: false,
      },
      annotations,
    });
  }

  tools.sort((a, b) => a.name.localeCompare(b.name));

  return {
    note: 'AUTO-GENERATED by scripts/gen-commands.mjs — DO NOT EDIT',
    tools,
  };
}
