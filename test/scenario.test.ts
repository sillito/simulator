import * as service from "../src/service";
import * as sinon from "sinon";
import * as chai from "chai";
import { expect } from "chai";
import * as sinonChai from "sinon-chai";

import {
  parseScenarioConfiguration,
  ScenarioConfiguration
} from "../src/scenario";

describe("scenario", () => {
  beforeEach(() => {});

  afterEach(() => {});

  context("#parseScenarioConfiguration", () => {
    it("reads services", async () => {
      const config = {
        autoAssign: {},
        services: [
          {
            name: "Example Service"
          },
          {
            name: "Other Service"
          }
        ],
        endpoints: []
      };
      const { allServices, services } = parseScenarioConfiguration(config);
      expect(allServices.length).to.eq(2);
      expect(services.length).to.eq(2);
      services.forEach(s => {
        expect(
          config.services.find(configService => configService.name == s.name)
        ).to.exist;
      });
    });
    it("reads endpoints", async () => {
      const config = {
        autoAssign: {},
        services: [],
        endpoints: [
          {
            name: "Example Service",
            dependencies: []
          },
          {
            name: "Other Service"
          }
        ]
      };
      const { allServices, services } = parseScenarioConfiguration(config);
      expect(allServices.length).to.eq(2);
      expect(services.length).to.eq(2);
      services.forEach(s => {
        expect(
          config.services.find(configService => configService.name == s.name)
        ).to.exist;
      });
    });
  });
});
