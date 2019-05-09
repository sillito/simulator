import { ServiceConfiguration } from "./service";
import { spawn } from "child_process";
import * as fs from "fs";
const concurrently = require("concurrently");

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
      console.log(`Matched ${dep.name} to ${dep.service}`);
    } else {
      throw new Error(
        `Could not find a matching service with name ${
          dep.name
        } for the endpoint.`
      );
    }
  }
});

process.on("exit", function() {
  finish();
});
const childProcesses = [];
run();

async function run() {
  console.log("*** Prepping Folders ***");
  const folder = createResultsFolder();

  console.log("*** Starting Services ***");
  await startServices(folder).catch(err => {
    console.error("Could not start services: " + err);
    return process.exit(0);
  });

  await console.log("*** Running WRK ***");
  await runExperiment(folder).catch(err => {
    console.error("Could not start wrk: " + err);
    return process.exit(0);
  });

  console.log("*** Processing Metrics ***");
  await gatherMetrics(folder).catch(err => {
    console.error("Could not start gather metrics: " + err);
    return process.exit(0);
  });

  process.exit(0);
}

function createResultsFolder() {
  const date = new Date().toISOString().substring(0, 10);
  var dir = `./results-${date}`;

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
  }
  return dir;
}

async function startServices(outputFolder) {
  services.concat([scenarioConfiguration.endpoint]).forEach(s => {
    const logStream = fs.createWriteStream(
      `${outputFolder}/${s.name}.metrics`,
      {
        flags: "a"
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

async function runExperiment(outputFolder) {
  const command =
    "wrk -t 2 -c 150 -d 15s -R 100 --timeout 15s -L " +
    (scenarioConfiguration.endpoint.hostname || "http://127.0.0.1") +
    ":" +
    scenarioConfiguration.endpoint.port +
    ` > ${outputFolder}/wk1.output`;
  console.error(command);
  return concurrently([command], {
    prefix: "WRK",
    prefixLength: 15,
    killOthers: ["failure", "success"]
  });
}
async function gatherMetrics(outputFolder) {
  return concurrently(
    [
      `node summarize-metrics.js --trial 1 < ${outputFolder}/ProductPage.metrics`
    ],
    { prefix: "none", prefixLength: 0, killOthers: ["failure", "success"] }
  );
}

async function finish() {
  console.log(`*** Killing ${childProcesses.length} Child Processes ***`);
  childProcesses.forEach(c => {
    let a = c.kill("SIGTERM");
    console.log(" --> ", a);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
