import { respond, callServicesSerially } from "../src/service";
import * as service from "../src/service";
import * as sinon from "sinon";
import * as chai from "chai";
import { expect } from "chai";
import * as sinonChai from "sinon-chai";
import * as nock from "nock";
import * as url from "url";

chai.use(sinonChai);
nock.disableNetConnect();

describe("service", () => {
  let sandbox;
  let serviceNock;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    serviceNock = nock("http://example.com").persist();
    nock.cleanAll();
  });

  afterEach(() => {
    sandbox.restore();
  });

  function nockServices(services, faultyServices = []) {
    services.forEach(s => {
      serviceNock.get(url.parse(s).pathname).reply(200, "hi");
    });
    faultyServices.forEach(s => {
      serviceNock.get(url.parse(s).pathname).reply(500, "error");
    });
  }

  context("#callServicesSerially", () => {
    it("returns 200 if all services are good", async () => {
      nockServices(["http://example.com/good", "http://example.com/other"]);
      const status = await callServicesSerially(1, [
        "http://example.com/good",
        "http://example.com/other"
      ]);
      expect(status).to.be.eq(200);
    });
    it("returns 500 if one service returns 500", async () => {
      nockServices(
        ["http://example.com/good", "http://example.com/other"],
        ["http://example.com/bad"]
      );
      const status = await callServicesSerially(1, [
        "http://example.com/good",
        "http://example.com/bad",
        "http://example.com/other"
      ]);
      expect(status).to.be.eq(500);
    });
    it("stops calling service at first 500", async () => {
      nockServices(["http://example.com/good"], ["http://example.com/bad"]);
      const status = await callServicesSerially(1, [
        "http://example.com/bad",
        "http://example.com/good"
      ]);
      expect(status).to.be.eq(500);
      expect(serviceNock.isDone());
    });
    it("returns 500 when services don't exist", async () => {
      nockServices([], ["http://example.com/bad"]);
      const status = await callServicesSerially(1, [
        "http://example.com/good",
        "http://example.com/bad"
      ]);
      expect(status).to.be.eq(500);
    });
  });

  context("#respond", () => {
    function createResponseObject() {
      let headers = [],
        body,
        statusCode;
      return {
        headers,
        body,
        statusCode,
        setHeader: function(header, value) {
          this.headers.push({ header, value });
        },
        end: function(responseBody) {
          this.body = responseBody;
        }
      };
    }
    it("200 return correct text/html content-type and body", () => {
      let res = createResponseObject();
      respond(res, 200);
      expect(res.statusCode).to.eql(200);
      expect(res.body).to.eql("hi");
      expect(res.headers).to.deep.include({
        header: "Content-Type",
        value: "text/html"
      });
    });
    it("500 return correct text/html content-type and error body", () => {
      let res = createResponseObject();
      respond(res, 500);
      expect(res.statusCode).to.eql(500);
      expect(res.body).to.eql("error");
      expect(res.headers).to.deep.include({
        header: "Content-Type",
        value: "text/html"
      });
    });
    it("other status return correct text/html content-type and error body", () => {
      let res = createResponseObject();
      respond(res, 800);
      expect(res.statusCode).to.eql(800);
      expect(res.body).to.eql("error");
      expect(res.headers).to.deep.include({
        header: "Content-Type",
        value: "text/html"
      });
    });
  });
});
