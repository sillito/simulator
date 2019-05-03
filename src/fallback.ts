export const alwaysSucceed = async function(service, request): Promise<number> {
  console.error("Fallback was called bro");
  return 200;
};
