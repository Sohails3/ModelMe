using System;
using System.Numerics;

namespace blazor_csharp_web.Models
{
    public class MannequinController
    {
        public Vector3 Position { get; set; } = Vector3.Zero;
        public Vector3 Scale { get; set; } = Vector3.One;

        public void ResetTransform()
        {
            Position = Vector3.Zero;
            Scale = Vector3.One;
        }

        // Safety function to be called from JS or Blazor after load
        public void OnModelLoaded()
        {
            ResetTransform();
            Console.WriteLine("C#: Mannequin Transform Reset to (0,0,0) and (1,1,1)");
        }
    }
}
