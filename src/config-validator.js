const Ajv2020 = require("ajv/dist/2020");
const schema = require("../schemas/repository-config.schema.json");

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

function validateRepositoryConfig(config) {
  if (validate(config)) return config;
  const details = (validate.errors || [])
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
  throw new Error(`Generated Maestro manifest does not match the repository-config schema: ${details}`);
}

module.exports = { validateRepositoryConfig };
