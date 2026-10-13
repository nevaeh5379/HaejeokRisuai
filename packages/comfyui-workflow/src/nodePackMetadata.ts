// Lightweight validation for optional node-pack metadata; no Zod runtime.
const repoId = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;
const version =
  /^(?:[0-9a-f]{4,40}|(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\da-z-]+(?:\.[\da-z-]+)*)?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?)$/i;
const parser = (
  valid: (value: string) => boolean,
  normalize = (value: string) => value,
) => ({
  safeParse(value: unknown) {
    const data = typeof value === "string" ? normalize(value) : undefined;
    return { data: data !== undefined && valid(data) ? data : undefined };
  },
});
export const nodePackMetadata = {
  shape: {
    cnr_id: parser((value) => value.length <= 100 && repoId.test(value)),
    aux_id: parser((value) => {
      const [owner, repo, extra] = value.split("/");
      return (
        !extra &&
        !!owner &&
        owner.length <= 39 &&
        /^(?!-)(?!.*--)[a-zA-Z0-9-]+(?<!-)$/.test(owner) &&
        !!repo &&
        repo.length <= 100 &&
        repoId.test(repo)
      );
    }),
    ver: parser(
      (value) => value === "unknown" || version.test(value),
      (value) => value.replace(/^v/, ""),
    ),
  },
};
