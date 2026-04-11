namespace blazor_csharp_web.Models
{
    public class ClothConfiguration
    {
        public int Resolution { get; set; } = 15;
        public float Width { get; set; } = 1.4f;
        public float Height { get; set; } = 0.8f;
        public float Gravity { get; set; } = -9.81f;
        public int Iterations { get; set; } = 5;
        public float Drag { get; set; } = 0.95f;
        public float Stiffness { get; set; } = 0.5f;
        public float Friction { get; set; } = 0.3f;
    }
}
