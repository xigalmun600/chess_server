{
  description = "Very basic chess server";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs?ref=nixos-unstable";
  };

  outputs = { self, nixpkgs }: let pkgs = nixpkgs.legacyPackages.x86_64-linux;
      in {
        devShells.x86_64-linux.default = pkgs.mkShell {
        packages = with pkgs; [ nixd alejandra nodejs_22 ];
        shellHook = '' echo "hola" '';
      };
  };
}
