#!/usr/bin/env bash
# Runs in GitHub Actions with repository-scoped GH_TOKEN and Helm 3 available.
set -euo pipefail
: "${GITHUB_REPOSITORY:?Required}"
: "${GITHUB_SHA:?Required}"
: "${HELM_REPO_DIR:?Set an empty output directory}"
: "${HELM_REPO_URL:?Public Pages URL}"
if [ -e "$HELM_REPO_DIR" ]; then
  echo 'Output directory already exists; refusing to overwrite it.' >&2
  exit 1
fi
mkdir -p "$HELM_REPO_DIR"

chart=charts/issue-tracker
version=$(helm show chart "$chart" | sed -n 's/^version: //p')
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$ ]] || { echo 'Unsupported chart version'; exit 1; }
tag="helm-issue-tracker-$version"

# Restore every published chart version. GitHub Releases are the durable archive;
# Pages serves copies of the packages and index.yaml as a standard Helm repository.
gh api --paginate "repos/$GITHUB_REPOSITORY/releases?per_page=100" \
  --jq '.[] | select(.draft == false) | .tag_name' > "$HELM_REPO_DIR/release-tags.txt"
while IFS= read -r previous; do
  if [[ "$previous" == helm-issue-tracker-* ]]; then
    gh release download "$previous" --repo "$GITHUB_REPOSITORY" \
      --pattern 'issue-tracker-*.tgz' --dir "$HELM_REPO_DIR"
  fi
done < "$HELM_REPO_DIR/release-tags.txt"
rm "$HELM_REPO_DIR/release-tags.txt"

mkdir "$HELM_REPO_DIR/candidate"
helm package "$chart" --destination "$HELM_REPO_DIR/candidate"
package="issue-tracker-$version.tgz"
if [ -f "$HELM_REPO_DIR/$package" ]; then
  # Packaging timestamps may differ; compare names and bytes, never replace an
  # already published version with different content.
  python3 - "$HELM_REPO_DIR/$package" "$HELM_REPO_DIR/candidate/$package" <<'PY'
import sys, tarfile

def contents(path):
    with tarfile.open(path) as archive:
        return {item.name: archive.extractfile(item).read() for item in archive.getmembers() if item.isfile()}

if contents(sys.argv[1]) != contents(sys.argv[2]):
    sys.exit('Chart content changed without a version bump. Update Chart.yaml version.')
PY
else
  gh release create "$tag" "$HELM_REPO_DIR/candidate/$package" \
    --repo "$GITHUB_REPOSITORY" --target "$GITHUB_SHA" --latest=false \
    --title "Helm chart $version" \
    --notes "Threadline Helm chart $version. Repository: $HELM_REPO_URL . Install with an explicit published application image tag and an existing settings-key Secret; claim initial admin setup privately before enabling ingress."
  mv "$HELM_REPO_DIR/candidate/$package" "$HELM_REPO_DIR/$package"
fi
rm -r "$HELM_REPO_DIR/candidate"
helm repo index "$HELM_REPO_DIR" --url "$HELM_REPO_URL"
cp scripts/helm-repository.html "$HELM_REPO_DIR/index.html"
touch "$HELM_REPO_DIR/.nojekyll"
