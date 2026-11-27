### Fixed

- When a push's refspec source is a full commit id that neither the clone nor its origin has, the ship gate's next step now ends with "push a commit that exists" instead of telling you to review the change again on another base.
