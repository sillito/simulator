import { ServiceConfiguration } from "./service";
const args = require("minimist")(process.argv.slice(2), {
  default: {
    config: "./scenario.example.json"
  }
});

type LoadableServiceConfiguration = ServiceConfiguration & { file: string };

type ScenarioConfiguration = {
  description: string;
  autoAssign: {
    port: boolean;
  };
  services: LoadableServiceConfiguration[];
  endpoint: LoadableServiceConfiguration;
};

let scenarioConfiguration: ScenarioConfiguration;
try {
  scenarioConfiguration = require(args.config);
} catch (err) {
  throw new Error(
    `Invalid Scenario Configuration File Path Specified: ${args.config}`
  );
}

let portStarting = 3000;
const services = scenarioConfiguration.services.map(s => {
  // if referring to a configuration file, load it
  if (s.file) {
    let configFile: ServiceConfiguration;
    try {
      configFile = require(s.file);
    } catch (err) {
      throw new Error(
        `Invalid Service Configuration File Path Specified: ${s.file}`
      );
    }
    // merge the settings, allow settings to be overwritten if specified in the scenario file
    s = {
      ...configFile,
      ...s
    };

    delete s.file;
  }

  // auto assign stuff, so we can refer to names instead of host/url in dependencies if needed
  if (scenarioConfiguration.autoAssign.port) {
    s.port = ++portStarting;
  }

  return s;
});

// update the endpoints dependencies if needed
scenarioConfiguration.endpoint.dependencies.forEach(dep => {
  if (dep.name) {
    const matchedService = services.find(s => s.name == dep.name);
    if (matchedService) {
      dep.service =
        matchedService.hostname || "http://127.0.0.1:" + matchedService.port;
    } else {
      throw new Error(
        `Could not find a matching service with name ${
          dep.name
        } for the endpoint.`
      );
    }
  }
});

const commands = services
  .concat([scenarioConfiguration.endpoint])
  .map(s => "node ./dist/service.js --configJSON " + JSON.stringify(s));

const concurrently = require("concurrently");
concurrently(commands).then(runExperiment, async err => {
  throw new Error("Could not start services: " + err);
});

async function runExperiment() {
  concurrently(commands).then(gatherMetrics, async err => {
    throw new Error("Could not start wrk: " + err);
  });
}
async function gatherMetrics() {
  concurrently(["wrk -t 2 -c 150 -d 15s -R 100 --timeout 15s -L "]).then(
    finish,
    async err => {
      throw new Error("Could not start gather metrics: " + err);
    }
  );
}

async function finish() {
  process.exit(0);
}
