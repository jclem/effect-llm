export const mergeParams = <
  A extends { additionalParameters?: Record<string, unknown> | undefined },
  B extends { additionalParameters?: Record<string, unknown> | undefined },
>(
  a: A | undefined,
  b: B | undefined,
): A & B => {
  return {
    ...a,
    ...b,
    additionalParameters: {
      ...a?.additionalParameters,
      ...b?.additionalParameters,
    },
  } as A & B;
};
