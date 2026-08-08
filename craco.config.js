module.exports = {
  webpack: {
    configure: (webpackConfig, { env }) => {
      if (env === 'production') {
        // Find the TerserPlugin more reliably using constructor name
        const terserPlugin = webpackConfig.optimization.minimizer.find(
          (plugin) => plugin.constructor.name === 'TerserPlugin'
        );

        if (terserPlugin) {
          // Safely initialize options if it doesn't exist
          if (!terserPlugin.options) {
            terserPlugin.options = {};
          }
          // Then safely initialize minimizer if it doesn't exist
          if (!terserPlugin.options.minimizer) {
            terserPlugin.options.minimizer = {};
          }
          // Then safely initialize minimizer.options if it doesn't exist
          if (!terserPlugin.options.minimizer.options) {
            terserPlugin.options.minimizer.options = {};
          }
          const minimizerOptions = terserPlugin.options.minimizer.options;
          // Now safely set compress options
          minimizerOptions.compress = {
            ...(minimizerOptions.compress || {}),
            drop_console: true,
          };
        } else {
          // Optional: Log a warning during build (this won't appear in production JS)
          console.warn('TerserPlugin not found in minimizers.');
        }
      }
      // Always return the config (moved outside the if)
      return webpackConfig;
    },
  },
};
