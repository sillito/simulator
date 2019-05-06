export const alwaysSucceed = async function(service, request): Promise<number> {
  return 200;
};
export const alwaysFail = async function(service, request): Promise<number> {
  return 500;
};
