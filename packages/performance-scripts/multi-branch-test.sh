# run tests across all branches

BRANCHES="${@:-performance-scripts experiment-fast-transformer linear-traversal}"

# cd $0/../test-app

for branch in $BRANCHES; do
  git checkout $branch
  pnpm i
  pnpm -r clean
  pnpm -r build
  DIR="result_$branch"
  mkdir $DIR

  pushd ../test-app
  for prof_type in sqlite js-cpu linux-native; do
    PROFILE_TYPE=$prof_type NODE_OPTIONS='-r ../performance-scripts' \
      node lib/Main.js --sourceFile ~/work/bad-aspect-old.bim \
          --targetDestination /tmp/out.bim
    mv *.cpuprofile *-profile.db $DIR
  done
  popd
done

