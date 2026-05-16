{
  description = "Development shell for inoreader-notion-bridge";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forEachSystem = f:
        nixpkgs.lib.genAttrs systems (
          system:
          f {
            pkgs = import nixpkgs { inherit system; };
          }
        );
    in
    {
      devShells = forEachSystem (
        { pkgs }:
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24
              pkgs.pnpm
            ];

            shellHook = ''
              echo "Loaded nix dev shell with Node $(${pkgs.nodejs_24}/bin/node --version)"
              echo "pnpm version: $(pnpm --version)"
              echo "Use .dev.vars for local Wrangler secrets."
            '';
          };
        }
      );
    };
}
