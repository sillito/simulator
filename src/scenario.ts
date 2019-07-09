import { ServiceConfiguration } from "./service";
import { Fallback } from "./DependencyPool";
import { spawn } from "child_process";
import * as fs from "fs";
import * as concurrently from "concurrently";
import * as merge from "lodash.merge";
import * as path from "path";

type LoadableServiceConfiguration = ServiceConfiguration & {
  name: string;
  file: string;
};

export type ScenarioConfiguration = {
  description: string;
  autoAssign: {
    port?: boolean;
  };
  services: LoadableServiceConfiguration[];
  endpoints: LoadableServiceConfiguration[];
};

function loadServiceConfiguration(s) {
  // if referring to a configuration file, load it
  if (s.file) {
    let configFile: ServiceConfiguration;
    try {
      configFile = { ...require(s.file) };
    } catch (err) {
      throw new Error(
        `Invalid Service Configuration File Path Specified: ${s.file}`
      );
    }
    // merge the settings, allow settings to be overwritten if specified in the scenario file
    // merge uses lodash.merge (documentation: https://lodash.com/docs#merge )
    s = merge({}, configFile, s);

    delete s.file;
  }
  return s;
}

function matchServiceDependencies(
  service: ServiceConfiguration,
  allServices: ServiceConfiguration[]
) {
  if (!service.dependencies) return;

  service.dependencies.forEach(dep => {
    matchService(dep, allServices);
    matchFallbacks(dep.fallback, allServices);
  });
}

function matchFallbacks(
  fallback: Fallback,
  allServices: ServiceConfiguration[]
) {
  if (!fallback) {
    return;
  }
  if (fallback.dependency) {
    matchService(fallback.dependency, allServices);
    return matchFallbacks(fallback.dependency.fallback, allServices);
  }
}

function matchService(
  dep: { name: string; service: string },
  allServices: ServiceConfiguration[]
) {
  if (dep.name) {
    const matchedService = allServices.find(s => s.name == dep.name);
    if (matchedService) {
      dep.service =
        matchedService.hostname || "http://127.0.0.1:" + matchedService.port;
      console.log(`Matched ${dep.name} to ${dep.service}`);
    } else {
      console.error(" Services ---> ", allServices);
      console.error(" Dependency ---> ", dep);
      throw new Error(
        `Could not find a matching service with name ${
          dep.name
        } for the endpoint.`
      );
    }
  }
}

function loadConfiguration(args) {
  let scenarioConfiguration: ScenarioConfiguration;
  let defaultConfiguration = {
    autoAssign: {}
  };
  try {
    scenarioConfiguration = { ...require(args.config) };
  } catch (err) {
    throw new Error(
      `Invalid Scenario Configuration File Path Specified: ${args.config}`
    );
  }
  scenarioConfiguration = merge(
    {},
    defaultConfiguration,
    scenarioConfiguration
  );
  return parseScenarioConfiguration(scenarioConfiguration);
}

export function parseScenarioConfiguration(scenarioConfiguration) {
  const services = scenarioConfiguration.services.map(s =>
    loadServiceConfiguration(s)
  );
  const endpoints = scenarioConfiguration.endpoints.map(e =>
    loadServiceConfiguration(e)
  );
  //console.error("services", services);
  const allServices = services.concat(endpoints);

  // auto assign stuff, so we can refer to names instead of host/url in dependencies if needed
  let portStarting = 3000;
  allServices.forEach(s => {
    if (scenarioConfiguration.autoAssign.port) {
      s.port = ++portStarting;
    }
  });

  // match service dependencies with other services by name.
  allServices.forEach(s => matchServiceDependencies(s, allServices));

  return { allServices, services, endpoints };
}

async function run() {
  console.log("*** Prepping Folders ***");
  const folder = createResultsFolder();

  const args = require("minimist")(process.argv.slice(2), {
    default: {
      config: "./scenario.example.json"
    }
  });
  const { allServices, services, endpoints } = loadConfiguration(args);

  console.log("*** Starting Services ***");
  await startServices(allServices, folder).catch(err => {
    console.error("Could not start services: " + err);
    return process.exit(0);
  });

  await console.log("*** Running WRK ***");
  await runExperiment(endpoints, folder).catch(err => {
    console.error("Could not start wrk: " + err);
    return process.exit(0);
  });

  console.log("*** Processing Metrics ***");
  await gatherMetrics(endpoints, folder).catch(err => {
    console.error("Could not start gather metrics: " + err);
    return process.exit(0);
  });

  process.exit(0);
}

function createResultsFolder() {
  const date = new Date().toISOString().substring(0, 10);
  const dir = `./results-${date}`;

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  } else {
    // clear the directory
    const files = fs.readdirSync(dir);
    files.forEach(f => fs.unlinkSync(path.join(dir, f)));
  }

  return dir;
}

function sanitizeServiceName(name) {
  return name.replace(/ /g, "_").replace(/\W/g, "");
}

async function startServices(allServices, outputFolder) {
  allServices.forEach(s => {
    const logStream = fs.createWriteStream(
      `${outputFolder}/${sanitizeServiceName(s.name)}.metrics`,
      {
        flags: "w"
      }
    );
    const node = spawn("node", [
      "./dist/service.js",
      "--configJSON",
      JSON.stringify(s).replace(/"/g, '\\"')
    ]);
    childProcesses.push(node);
    node.stdout.pipe(logStream);
    node.stderr.pipe(process.stderr);

    node.on("close", function(code) {
      console.log("child process exited with code " + code);
    });
  });
  return sleep(2000);
}

async function runExperiment(endpoints, outputFolder) {
  for (let i = 0; i < endpoints.length; i++) {
    const e = endpoints[i];
    const host = e.hostname || "http://127.0.0.1";
    const filename = sanitizeServiceName(e.name);

    /*
    const wrk = "wrk -t 2 -c 20 -d 1s -R 50 --timeout 15s -L ";
    const output = ` > ${outputFolder}/${filename}.wrk.output`;
    let command = wrk + host + ":" + e.port + output;
    */

    const logStream = fs.createWriteStream(
      `${outputFolder}/${filename}.wrk.output`,
      {
        flags: "a"
      }
    );
    const node = spawn("wrk", [
      "-t",
      "2",
      "-c",
      "20",
      "-d",
      "15s",
      "-R",
      "100",
      "--timeout",
      "15s",
      "-L",
      host + ":" + e.port
    ]);
    childProcesses.push(node);
    node.stdout.pipe(logStream);
    node.stderr.pipe(process.stderr);

    await new Promise((resolve, reject) => {
      node.on("close", function(code) {
        const percent = (i / endpoints.length) * 100;
        console.log(`${percent.toFixed(0)}% complete`);
        resolve();
      });
    });
  }

  /*return concurrently(commands, {
    prefix: "WRK",
    prefixLength: 15,
    killOthers: ["failure", "success"]
  });*/
}
async function gatherMetrics(endpoints, outputFolder) {
  const commands = endpoints.map(
    (e, index) =>
      `node ./dist/summarize-metrics.js --name ${sanitizeServiceName(
        e.name
      )} --csv --wrkReport ${outputFolder}/${sanitizeServiceName(
        e.name
      )}.wrk.output < ${outputFolder}/${sanitizeServiceName(e.name)}.metrics`
  );
  return concurrently(commands, {
    prefix: "none",
    prefixLength: 0,
    killOthers: ["failure", "success"]
  });
}

async function finish() {
  console.log(`*** Killing ${childProcesses.length} Child Processes ***`);
  childProcesses.forEach(c => {
    let a = c.kill("SIGTERM");
    // console.log(" --> ", a);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const childProcesses = [];

if (require.main === module) {
  process.on("exit", function() {
    finish();
  });
  run();
}
