{
  description = "LivePortrait Avatar API — Scaleway GPU service for MHH-EI";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachSystem [ "x86_64-linux" "aarch64-darwin" ] (system:
      let
        pkgs = import nixpkgs { inherit system; };

        # Python environment with LivePortrait dependencies
        pythonEnv = pkgs.python311.withPackages (ps: with ps; [
          fastapi
          uvicorn
          torch
          torchvision
          numpy
          pillow
          python-multipart
        ]);

        # OCI image for Scaleway deployment (x86_64-linux only)
        oci-image = pkgs.dockerTools.buildLayeredImage {
          name = "rg.fr-par.scw.cloud/sanmarcsoft/liveportrait-api";
          tag = "latest";
          maxLayers = 120;

          contents = [
            pythonEnv
            pkgs.coreutils
            pkgs.cacert
          ];

          config = {
            Cmd = [
              "${pythonEnv}/bin/python"
              "/app/server.py"
            ];
            Env = [
              "PORT=8090"
              "MODELS_DIR=/models"
              "CACHE_DIR=/cache"
              "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
            ];
            ExposedPorts = {
              "8090/tcp" = {};
            };
            WorkingDir = "/app";
            Volumes = {
              "/models" = {};
              "/cache" = {};
            };
          };

          extraCommands = ''
            mkdir -p app
            cp ${./server.py} app/server.py
          '';
        };

      in {
        packages = {
          inherit oci-image;
          default = pythonEnv;
        };

        devShells.default = pkgs.mkShell {
          buildInputs = [
            pythonEnv
            pkgs.skopeo
          ];
        };
      }
    );
}
